package aamp

import (
	"bytes"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

type Client struct {
	*Emitter
	Config             Config
	SmtpSender         *SmtpSender
	JmapClient         *JmapPushClient
	HTTPClient         *http.Client
	streamAppendMu     sync.Mutex
	streamAppendQueues map[string]*streamAppendQueue
}

type streamAppendQueue struct {
	cond       *sync.Cond
	running    bool
	operations []*streamAppendOperation
}

type streamAppendOperation struct {
	kind    string
	opts    AppendStreamEventOptions
	text    string
	payload map[string]any
	waiters []chan streamAppendResult
}

type streamAppendResult struct {
	event *StreamEvent
	err   error
}

func NewClient(config Config) (*Client, error) {
	if config.Email == "" || config.MailboxToken == "" || config.BaseURL == "" || config.SMTPPassword == "" {
		return nil, fmt.Errorf("email, mailbox token, base URL, and SMTP password are required")
	}
	smtpHost, _ := DeriveMailboxServiceDefaults(config.Email, config.BaseURL)
	if config.SMTPHost == "" {
		config.SMTPHost = smtpHost
	}
	if config.SMTPPort == 0 {
		config.SMTPPort = 587
	}
	httpSendBaseURL := config.HTTPSendBaseURL
	if httpSendBaseURL == "" {
		httpSendBaseURL = config.BaseURL
	}
	httpClient := newAPIClient(config.RejectUnauthorized)
	sender := NewSmtpSender(
		config.SMTPHost,
		config.SMTPPort,
		config.Email,
		config.SMTPPassword,
		httpSendBaseURL,
		config.MailboxToken,
		config.RejectUnauthorized,
	)
	sender.HTTPClient = httpClient

	password, err := decodeMailboxToken(config.MailboxToken)
	if err != nil {
		return nil, err
	}
	jmapClient := NewJmapPushClient(
		config.Email,
		password,
		config.BaseURL,
		func() time.Duration {
			if config.ReconnectInterval > 0 {
				return config.ReconnectInterval
			}
			return 5 * time.Second
		}(),
		config.RejectUnauthorized,
	)
	jmapClient.httpClient = httpClient

	client := &Client{
		Emitter:            NewEmitter(),
		Config:             config,
		SmtpSender:         sender,
		JmapClient:         jmapClient,
		HTTPClient:         httpClient,
		streamAppendQueues: make(map[string]*streamAppendQueue),
	}
	for _, eventName := range []string{
		"task.dispatch",
		"task.cancel",
		"task.result",
		"task.help_needed",
		"task.ack",
		"task.stream.opened",
		"card.query",
		"card.response",
		"reply",
		"connected",
		"disconnected",
		"error",
	} {
		name := eventName
		jmapClient.On(name, func(payload any) {
			client.Emit(name, payload)
		})
	}
	jmapClient.On("_autoAck", func(payload any) {
		autoAck, ok := payload.(autoAckPayload)
		if !ok {
			return
		}
		if err := client.SmtpSender.SendAck(autoAck.To, autoAck.TaskID, autoAck.MessageID); err != nil {
			client.Emit("error", fmt.Errorf("[AAMP] failed to send ACK for task %s: %w", autoAck.TaskID, err))
		}
	})
	return client, nil
}

func decodeMailboxToken(token string) (string, error) {
	decoded, err := base64.StdEncoding.DecodeString(token)
	if err != nil {
		return "", fmt.Errorf("failed to decode mailboxToken: %w", err)
	}
	parts := strings.SplitN(string(decoded), ":", 2)
	if len(parts) != 2 || parts[1] == "" {
		return "", fmt.Errorf("invalid mailboxToken format: expected base64(email:password)")
	}
	return parts[1], nil
}

func FromMailboxIdentity(config MailboxIdentityConfig) (*Client, error) {
	smtpHost, baseURL := DeriveMailboxServiceDefaults(config.Email, config.BaseURL)
	if config.SMTPPort == 0 {
		config.SMTPPort = 587
	}
	token := base64.StdEncoding.EncodeToString([]byte(config.Email + ":" + config.SMTPPassword))
	return NewClient(Config{
		Email:              config.Email,
		MailboxToken:       token,
		BaseURL:            firstNonEmpty(baseURL, "https://"+strings.SplitN(config.Email, "@", 2)[1]),
		SMTPHost:           smtpHost,
		SMTPPort:           config.SMTPPort,
		SMTPPassword:       config.SMTPPassword,
		ReconnectInterval:  config.ReconnectInterval,
		RejectUnauthorized: config.RejectUnauthorized,
	})
}

func (c *Client) Connect() error {
	return c.JmapClient.Start()
}

func (c *Client) Disconnect() {
	c.JmapClient.Stop()
}

func (c *Client) IsConnected() bool {
	return c.JmapClient.IsConnected()
}

func (c *Client) IsUsingPollingFallback() bool {
	return c.JmapClient.IsUsingPollingFallback()
}

func DiscoverAampService(aampHost string, rejectUnauthorized bool) (*DiscoveryDocument, error) {
	client := newAPIClient(rejectUnauthorized)
	base := strings.TrimRight(aampHost, "/")
	req, err := http.NewRequest(http.MethodGet, base+"/.well-known/aamp", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	res, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, fmt.Errorf("AAMP discovery failed: %s", res.Status)
	}
	var discovery DiscoveryDocument
	if err := json.NewDecoder(res.Body).Decode(&discovery); err != nil {
		return nil, err
	}
	if discovery.API == nil || discovery.API.URL == "" {
		return nil, fmt.Errorf("AAMP discovery did not return api.url")
	}
	return &discovery, nil
}

func RegisterMailbox(opts RegisterMailboxOptions, rejectUnauthorized bool) (*RegisteredMailboxIdentity, error) {
	base := strings.TrimRight(opts.AAMPHost, "/")
	var registration struct {
		RegistrationCode string `json:"registrationCode"`
	}
	if err := callDiscoveredAPI(newAPIClient(rejectUnauthorized), base, "aamp.mailbox.register", http.MethodPost, nil, map[string]any{
		"slug":        opts.Slug,
		"description": opts.Description,
	}, "", rejectUnauthorized, &registration); err != nil {
		return nil, err
	}
	if registration.RegistrationCode == "" {
		return nil, fmt.Errorf("mailbox registration succeeded but no registrationCode was returned")
	}
	var credentials struct {
		Email   string `json:"email"`
		Mailbox struct {
			Token string `json:"token"`
		} `json:"mailbox"`
		SMTP struct {
			Password string `json:"password"`
		} `json:"smtp"`
	}
	if err := callDiscoveredAPI(newAPIClient(rejectUnauthorized), base, "aamp.mailbox.credentials", http.MethodGet, map[string]string{
		"code": registration.RegistrationCode,
	}, nil, "", rejectUnauthorized, &credentials); err != nil {
		return nil, err
	}
	if credentials.Email == "" || credentials.Mailbox.Token == "" || credentials.SMTP.Password == "" {
		return nil, fmt.Errorf("mailbox credential exchange returned an incomplete identity payload")
	}
	return &RegisteredMailboxIdentity{
		Email:        credentials.Email,
		MailboxToken: credentials.Mailbox.Token,
		SMTPPassword: credentials.SMTP.Password,
		BaseURL:      base,
	}, nil
}

func (c *Client) SendTask(opts SendTaskOptions) (string, string, error) {
	return c.SmtpSender.SendTask(opts)
}

func (c *Client) SendResult(opts SendResultOptions) error {
	return c.SmtpSender.SendResult(opts)
}

func (c *Client) SendHelp(opts SendHelpOptions) error {
	return c.SmtpSender.SendHelp(opts)
}

func (c *Client) SendCancel(opts SendCancelOptions) error {
	return c.SmtpSender.SendCancel(opts)
}

func (c *Client) SendStreamOpened(to, taskID, streamID, inReplyTo string) error {
	return c.SmtpSender.SendStreamOpened(to, taskID, streamID, inReplyTo)
}

func (c *Client) SendCardQuery(opts SendCardQueryOptions) (string, string, error) {
	return c.SmtpSender.SendCardQuery(opts)
}

func (c *Client) SendCardResponse(opts SendCardResponseOptions) error {
	return c.SmtpSender.SendCardResponse(opts)
}

func (c *Client) DownloadBlob(blobID, filename string) ([]byte, error) {
	return c.JmapClient.DownloadBlob(blobID, filename)
}

func (c *Client) ReconcileRecentEmails(limit int, includeHistorical bool) (int, error) {
	return c.JmapClient.ReconcileRecentEmails(limit, includeHistorical)
}

func (c *Client) UpdateDirectoryProfile(opts UpdateDirectoryProfileOptions) (*AgentDirectoryProfile, error) {
	var response struct {
		Profile AgentDirectoryProfile `json:"profile"`
	}
	if err := callDiscoveredAPI(c.HTTPClient, c.Config.BaseURL, "aamp.directory.upsert", http.MethodPost, nil, opts, c.Config.MailboxToken, c.Config.RejectUnauthorized, &response); err != nil {
		return nil, err
	}
	return &response.Profile, nil
}

func (c *Client) ListDirectory(opts DirectoryListOptions) ([]AgentDirectoryEntry, error) {
	query := map[string]string{}
	if opts.Scope != "" {
		query["scope"] = opts.Scope
	}
	if opts.IncludeSelf != nil {
		query["includeSelf"] = fmt.Sprintf("%t", *opts.IncludeSelf)
	}
	if opts.Limit > 0 {
		query["limit"] = fmt.Sprintf("%d", opts.Limit)
	}
	var response struct {
		Agents []AgentDirectoryEntry `json:"agents"`
	}
	if err := callDiscoveredAPI(c.HTTPClient, c.Config.BaseURL, "aamp.directory.list", http.MethodGet, query, nil, c.Config.MailboxToken, c.Config.RejectUnauthorized, &response); err != nil {
		return nil, err
	}
	return response.Agents, nil
}

func (c *Client) SearchDirectory(opts DirectorySearchOptions) ([]AgentDirectorySearchEntry, error) {
	query := map[string]string{"q": opts.Query}
	if opts.Scope != "" {
		query["scope"] = opts.Scope
	}
	if opts.Limit > 0 {
		query["limit"] = fmt.Sprintf("%d", opts.Limit)
	}
	var response struct {
		Agents []AgentDirectorySearchEntry `json:"agents"`
	}
	if err := callDiscoveredAPI(c.HTTPClient, c.Config.BaseURL, "aamp.directory.search", http.MethodGet, query, nil, c.Config.MailboxToken, c.Config.RejectUnauthorized, &response); err != nil {
		return nil, err
	}
	return response.Agents, nil
}

func (c *Client) resolveStreamCapability() (*StreamCapability, error) {
	discovery, err := DiscoverAampService(c.Config.BaseURL, c.Config.RejectUnauthorized)
	if err != nil {
		return nil, err
	}
	if discovery.Capabilities == nil || discovery.Capabilities.Stream == nil || discovery.Capabilities.Stream.Transport == "" {
		return nil, fmt.Errorf("AAMP stream capability is not available on this service")
	}
	return discovery.Capabilities.Stream, nil
}

func (c *Client) CreateStream(opts CreateStreamOptions) (*CreateStreamResult, error) {
	stream, err := c.resolveStreamCapability()
	if err != nil {
		return nil, err
	}
	var response CreateStreamResult
	action := firstNonEmpty(stream.CreateAction, "aamp.stream.create")
	if err := callDiscoveredAPI(c.HTTPClient, c.Config.BaseURL, action, http.MethodPost, nil, opts, c.Config.MailboxToken, c.Config.RejectUnauthorized, &response); err != nil {
		return nil, err
	}
	return &response, nil
}

func (c *Client) getStreamAppendQueue(streamID string) *streamAppendQueue {
	c.streamAppendMu.Lock()
	defer c.streamAppendMu.Unlock()
	queue, ok := c.streamAppendQueues[streamID]
	if ok {
		return queue
	}
	queue = &streamAppendQueue{}
	queue.cond = sync.NewCond(&sync.Mutex{})
	c.streamAppendQueues[streamID] = queue
	return queue
}

func clonePayload(payload map[string]any) map[string]any {
	if payload == nil {
		return map[string]any{}
	}
	cloned := make(map[string]any, len(payload))
	for key, value := range payload {
		cloned[key] = value
	}
	return cloned
}

func (c *Client) dispatchStreamAppend(opts AppendStreamEventOptions) (*StreamEvent, error) {
	stream, err := c.resolveStreamCapability()
	if err != nil {
		return nil, err
	}
	var response StreamEvent
	action := firstNonEmpty(stream.AppendAction, "aamp.stream.append")
	if err := callDiscoveredAPI(c.HTTPClient, c.Config.BaseURL, action, http.MethodPost, nil, opts, c.Config.MailboxToken, c.Config.RejectUnauthorized, &response); err != nil {
		return nil, err
	}
	return &response, nil
}

func (c *Client) drainStreamAppendQueue(streamID string) {
	queue := c.getStreamAppendQueue(streamID)
	for {
		queue.cond.L.Lock()
		if len(queue.operations) == 0 {
			queue.running = false
			queue.cond.Broadcast()
			queue.cond.L.Unlock()

			c.streamAppendMu.Lock()
			if !queue.running && len(queue.operations) == 0 {
				delete(c.streamAppendQueues, streamID)
			}
			c.streamAppendMu.Unlock()
			return
		}
		operation := queue.operations[0]
		queue.operations = queue.operations[1:]
		queue.cond.L.Unlock()

		payload := clonePayload(operation.payload)
		if operation.kind == "text-delta-batch" {
			payload["text"] = operation.text
		}

		event, err := c.dispatchStreamAppend(AppendStreamEventOptions{
			StreamID: streamID,
			Type:     operation.opts.Type,
			Payload:  payload,
		})
		for _, waiter := range operation.waiters {
			waiter <- streamAppendResult{event: event, err: err}
			close(waiter)
		}
	}
}

func (c *Client) flushStreamAppendQueue(streamID string) {
	queue := c.getStreamAppendQueue(streamID)
	queue.cond.L.Lock()
	for queue.running || len(queue.operations) > 0 {
		queue.cond.Wait()
	}
	queue.cond.L.Unlock()
}

func (c *Client) AppendStreamEvent(opts AppendStreamEventOptions) (*StreamEvent, error) {
	queue := c.getStreamAppendQueue(opts.StreamID)
	waiter := make(chan streamAppendResult, 1)

	queue.cond.L.Lock()
	if opts.Type == "text.delta" {
		if text, ok := opts.Payload["text"].(string); ok {
			if len(queue.operations) > 0 {
				lastOperation := queue.operations[len(queue.operations)-1]
				if lastOperation.kind == "text-delta-batch" {
					lastOperation.text += text
					lastOperation.waiters = append(lastOperation.waiters, waiter)
					queue.cond.L.Unlock()
					result := <-waiter
					return result.event, result.err
				}
			}

			queue.operations = append(queue.operations, &streamAppendOperation{
				kind:    "text-delta-batch",
				opts:    opts,
				text:    text,
				payload: clonePayload(opts.Payload),
				waiters: []chan streamAppendResult{waiter},
			})
		} else {
			queue.operations = append(queue.operations, &streamAppendOperation{
				kind:    "single-event",
				opts:    opts,
				payload: clonePayload(opts.Payload),
				waiters: []chan streamAppendResult{waiter},
			})
		}
	} else {
		queue.operations = append(queue.operations, &streamAppendOperation{
			kind:    "single-event",
			opts:    opts,
			payload: clonePayload(opts.Payload),
			waiters: []chan streamAppendResult{waiter},
		})
	}

	if !queue.running {
		queue.running = true
		go c.drainStreamAppendQueue(opts.StreamID)
	}
	queue.cond.L.Unlock()

	result := <-waiter
	return result.event, result.err
}

func (c *Client) CloseStream(opts CloseStreamOptions) (*TaskStreamState, error) {
	c.flushStreamAppendQueue(opts.StreamID)
	stream, err := c.resolveStreamCapability()
	if err != nil {
		return nil, err
	}
	var response TaskStreamState
	action := firstNonEmpty(stream.CloseAction, "aamp.stream.close")
	if err := callDiscoveredAPI(c.HTTPClient, c.Config.BaseURL, action, http.MethodPost, nil, opts, c.Config.MailboxToken, c.Config.RejectUnauthorized, &response); err != nil {
		return nil, err
	}
	return &response, nil
}

func (c *Client) GetTaskStream(taskID, streamID string) (*TaskStreamState, error) {
	stream, err := c.resolveStreamCapability()
	if err != nil {
		return nil, err
	}
	query := map[string]string{}
	if taskID != "" {
		query["taskId"] = taskID
	}
	if streamID != "" {
		query["streamId"] = streamID
	}
	var response TaskStreamState
	action := firstNonEmpty(stream.GetAction, "aamp.stream.get")
	if err := callDiscoveredAPI(c.HTTPClient, c.Config.BaseURL, action, http.MethodGet, query, nil, c.Config.MailboxToken, c.Config.RejectUnauthorized, &response); err != nil {
		return nil, err
	}
	return &response, nil
}

func newAPIClient(rejectUnauthorized bool) *http.Client {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.TLSClientConfig = &tls.Config{
		InsecureSkipVerify: !rejectUnauthorized,
		MinVersion:         tls.VersionTLS12,
	}
	return &http.Client{Timeout: 30 * time.Second, Transport: transport}
}

func callDiscoveredAPI(client *http.Client, base, action, method string, query map[string]string, body any, authToken string, rejectUnauthorized bool, out any) error {
	discovery, err := DiscoverAampService(base, rejectUnauthorized)
	if err != nil {
		return err
	}
	if discovery.API == nil || discovery.API.URL == "" {
		return fmt.Errorf("AAMP discovery did not return api.url")
	}
	apiURL, err := url.Parse(discovery.API.URL)
	if err != nil {
		return err
	}
	baseURL, err := url.Parse(strings.TrimRight(base, "/") + "/")
	if err != nil {
		return err
	}
	resolved := baseURL.ResolveReference(apiURL)
	params := resolved.Query()
	params.Set("action", action)
	for key, value := range query {
		if strings.TrimSpace(value) != "" {
			params.Set(key, value)
		}
	}
	resolved.RawQuery = params.Encode()

	var requestBody io.Reader
	if body != nil {
		payload, err := json.Marshal(body)
		if err != nil {
			return err
		}
		requestBody = bytes.NewReader(payload)
	}
	req, err := http.NewRequest(method, resolved.String(), requestBody)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	if authToken != "" {
		req.Header.Set("Authorization", "Basic "+authToken)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		payload, _ := io.ReadAll(res.Body)
		return fmt.Errorf("AAMP API call failed: %s %s", res.Status, strings.TrimSpace(string(payload)))
	}
	return json.NewDecoder(res.Body).Decode(out)
}
