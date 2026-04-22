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

	"github.com/gorilla/websocket"
)

type jmapSession struct {
	PrimaryAccounts map[string]string         `json:"primaryAccounts"`
	Accounts        map[string]map[string]any `json:"accounts"`
	DownloadURL     string                    `json:"downloadUrl"`
}

type jmapEmailHeader struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

type jmapEmailAddress struct {
	Email string `json:"email"`
}

type jmapEmailTextBody struct {
	PartID string `json:"partId"`
}

type jmapBodyValue struct {
	Value string `json:"value"`
}

type jmapAttachment struct {
	BlobID string `json:"blobId"`
	Type   string `json:"type"`
	Name   string `json:"name"`
	Size   int    `json:"size"`
}

type jmapEmail struct {
	ID          string                   `json:"id"`
	Subject     string                   `json:"subject"`
	From        []jmapEmailAddress       `json:"from"`
	To          []jmapEmailAddress       `json:"to"`
	MessageID   []string                 `json:"messageId"`
	Headers     []jmapEmailHeader        `json:"headers"`
	ReceivedAt  string                   `json:"receivedAt"`
	TextBody    []jmapEmailTextBody      `json:"textBody"`
	BodyValues  map[string]jmapBodyValue `json:"bodyValues"`
	Attachments []jmapAttachment         `json:"attachments"`
}

type jmapPushStateChange struct {
	Type    string                       `json:"@type"`
	Changed map[string]map[string]string `json:"changed"`
}

type autoAckPayload struct {
	To        string
	TaskID    string
	MessageID string
}

type JmapPushClient struct {
	*Emitter

	email              string
	password           string
	jmapURL            string
	reconnectInterval  time.Duration
	rejectUnauthorized bool
	pingInterval       time.Duration
	safetySyncInterval time.Duration
	startedAt          time.Time

	httpClient *http.Client

	mu             sync.Mutex
	conn           *websocket.Conn
	session        *jmapSession
	reconnectTimer *time.Timer
	pollStop       chan struct{}
	safetyStop     chan struct{}
	seenMessageIDs map[string]struct{}
	connected      bool
	pollingActive  bool
	running        bool
	connecting     bool
	emailState     string
}

func NewJmapPushClient(email, password, jmapURL string, reconnectInterval time.Duration, rejectUnauthorized bool) *JmapPushClient {
	if reconnectInterval <= 0 {
		reconnectInterval = 5 * time.Second
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.TLSClientConfig = &tls.Config{
		InsecureSkipVerify: !rejectUnauthorized,
		MinVersion:         tls.VersionTLS12,
	}
	return &JmapPushClient{
		Emitter:            NewEmitter(),
		email:              email,
		password:           password,
		jmapURL:            strings.TrimRight(jmapURL, "/"),
		reconnectInterval:  reconnectInterval,
		rejectUnauthorized: rejectUnauthorized,
		pingInterval:       5 * time.Second,
		safetySyncInterval: 5 * time.Second,
		startedAt:          time.Now(),
		httpClient:         &http.Client{Timeout: 30 * time.Second, Transport: transport},
		seenMessageIDs:     map[string]struct{}{},
	}
}

func (j *JmapPushClient) authHeader() string {
	return "Basic " + base64.StdEncoding.EncodeToString([]byte(j.email+":"+j.password))
}

func (j *JmapPushClient) Start() error {
	j.mu.Lock()
	if j.running {
		j.mu.Unlock()
		return nil
	}
	j.running = true
	j.pollStop = make(chan struct{})
	j.safetyStop = make(chan struct{})
	j.mu.Unlock()
	j.startSafetySync()
	return j.connect()
}

func (j *JmapPushClient) Stop() {
	j.mu.Lock()
	j.running = false
	j.connected = false
	j.pollingActive = false
	if j.reconnectTimer != nil {
		j.reconnectTimer.Stop()
		j.reconnectTimer = nil
	}
	if j.conn != nil {
		_ = j.conn.Close()
		j.conn = nil
	}
	if j.pollStop != nil {
		select {
		case <-j.pollStop:
		default:
			close(j.pollStop)
		}
	}
	if j.safetyStop != nil {
		select {
		case <-j.safetyStop:
		default:
			close(j.safetyStop)
		}
	}
	j.mu.Unlock()
}

func (j *JmapPushClient) IsConnected() bool {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.connected || j.pollingActive
}

func (j *JmapPushClient) IsUsingPollingFallback() bool {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.pollingActive && !j.connected
}

func (j *JmapPushClient) fetchSession() (*jmapSession, error) {
	req, err := http.NewRequest(http.MethodGet, j.jmapURL+"/.well-known/jmap", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", j.authHeader())
	req.Header.Set("Accept", "application/json")
	res, err := j.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, fmt.Errorf("failed to fetch JMAP session: %s", res.Status)
	}
	var session jmapSession
	if err := json.NewDecoder(res.Body).Decode(&session); err != nil {
		return nil, err
	}
	return &session, nil
}

func (j *JmapPushClient) jmapCall(methods [][]any) (map[string]any, error) {
	j.mu.Lock()
	session := j.session
	j.mu.Unlock()
	if session == nil {
		return nil, fmt.Errorf("no JMAP session")
	}
	payload, err := json.Marshal(map[string]any{
		"using":       []string{"urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"},
		"methodCalls": methods,
	})
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequest(http.MethodPost, j.jmapURL+"/jmap/", bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", j.authHeader())
	req.Header.Set("Content-Type", "application/json")
	res, err := j.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, fmt.Errorf("JMAP API call failed: %s", res.Status)
	}
	var response map[string]any
	if err := json.NewDecoder(res.Body).Decode(&response); err != nil {
		return nil, err
	}
	return response, nil
}

func (j *JmapPushClient) primaryAccountID() (string, error) {
	j.mu.Lock()
	session := j.session
	j.mu.Unlock()
	if session == nil {
		return "", fmt.Errorf("no JMAP session")
	}
	if value := session.PrimaryAccounts["urn:ietf:params:jmap:mail"]; value != "" {
		return value, nil
	}
	for key := range session.Accounts {
		return key, nil
	}
	return "", fmt.Errorf("no mail account available in JMAP session")
}

func findMethodResponse(response map[string]any, methodName string) map[string]any {
	items, _ := response["methodResponses"].([]any)
	for _, item := range items {
		entry, _ := item.([]any)
		if len(entry) < 2 {
			continue
		}
		if name, _ := entry[0].(string); name == methodName {
			if payload, _ := entry[1].(map[string]any); payload != nil {
				return payload
			}
		}
	}
	return nil
}

func toStringSlice(value any) []string {
	items, _ := value.([]any)
	result := make([]string, 0, len(items))
	for _, item := range items {
		if text, _ := item.(string); text != "" {
			result = append(result, text)
		}
	}
	return result
}

func mapEmails(value any) ([]jmapEmail, error) {
	payload, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	var emails []jmapEmail
	if err := json.Unmarshal(payload, &emails); err != nil {
		return nil, err
	}
	return emails, nil
}

func (j *JmapPushClient) initEmailState(accountID string) error {
	response, err := j.jmapCall([][]any{{"Email/get", map[string]any{"accountId": accountID, "ids": []string{}}, "g0"}})
	if err != nil {
		return err
	}
	result := findMethodResponse(response, "Email/get")
	j.mu.Lock()
	j.emailState, _ = result["state"].(string)
	j.mu.Unlock()
	return nil
}

func (j *JmapPushClient) fetchEmailsSince(accountID, sinceState string) ([]jmapEmail, error) {
	response, err := j.jmapCall([][]any{{"Email/changes", map[string]any{"accountId": accountID, "sinceState": sinceState, "maxChanges": 50}, "c1"}})
	if err != nil {
		return nil, err
	}
	result := findMethodResponse(response, "Email/changes")
	if result == nil {
		if err := j.initEmailState(accountID); err != nil {
			return nil, err
		}
		return nil, nil
	}
	if newState, _ := result["newState"].(string); newState != "" {
		j.mu.Lock()
		j.emailState = newState
		j.mu.Unlock()
	}
	created := toStringSlice(result["created"])
	if len(created) == 0 {
		return nil, nil
	}
	response, err = j.jmapCall([][]any{{
		"Email/get",
		map[string]any{
			"accountId":           accountID,
			"ids":                 created,
			"properties":          []string{"id", "subject", "from", "to", "headers", "messageId", "receivedAt", "textBody", "bodyValues", "attachments"},
			"fetchTextBodyValues": true,
			"maxBodyValueBytes":   262144,
		},
		"g1",
	}})
	if err != nil {
		return nil, err
	}
	result = findMethodResponse(response, "Email/get")
	if result == nil {
		return nil, nil
	}
	return mapEmails(result["list"])
}

func (j *JmapPushClient) fetchRecentEmails(accountID string) ([]jmapEmail, error) {
	response, err := j.jmapCall([][]any{{
		"Email/query",
		map[string]any{
			"accountId": accountID,
			"sort":      []map[string]any{{"property": "receivedAt", "isAscending": false}},
			"limit":     20,
		},
		"q1",
	}})
	if err != nil {
		return nil, err
	}
	result := findMethodResponse(response, "Email/query")
	ids := toStringSlice(result["ids"])
	if len(ids) == 0 {
		return nil, nil
	}
	response, err = j.jmapCall([][]any{{
		"Email/get",
		map[string]any{
			"accountId":           accountID,
			"ids":                 ids,
			"properties":          []string{"id", "subject", "from", "to", "headers", "messageId", "receivedAt", "textBody", "bodyValues", "attachments"},
			"fetchTextBodyValues": true,
			"maxBodyValueBytes":   262144,
		},
		"gRecent",
	}})
	if err != nil {
		return nil, err
	}
	result = findMethodResponse(response, "Email/get")
	return mapEmails(result["list"])
}

func (j *JmapPushClient) shouldProcessBootstrapEmail(email jmapEmail) bool {
	receivedAt, err := time.Parse(time.RFC3339, email.ReceivedAt)
	if err != nil {
		return false
	}
	return receivedAt.After(j.startedAt.Add(-15 * time.Second))
}

func (j *JmapPushClient) processEmail(email jmapEmail) {
	headerMap := map[string]string{}
	for _, item := range email.Headers {
		headerMap[strings.ToLower(item.Name)] = strings.TrimSpace(item.Value)
	}
	fromAddr := ""
	if len(email.From) > 0 {
		fromAddr = email.From[0].Email
	}
	toAddr := ""
	if len(email.To) > 0 {
		toAddr = email.To[0].Email
	}
	messageID := email.ID
	if len(email.MessageID) > 0 && email.MessageID[0] != "" {
		messageID = email.MessageID[0]
	}

	j.mu.Lock()
	if _, ok := j.seenMessageIDs[messageID]; ok {
		j.mu.Unlock()
		return
	}
	j.seenMessageIDs[messageID] = struct{}{}
	j.mu.Unlock()

	bodyText := ""
	if len(email.TextBody) > 0 {
		bodyText = strings.TrimSpace(email.BodyValues[email.TextBody[0].PartID].Value)
	}

	message, err := ParseAampHeaders(EmailMetadata{
		From:      fromAddr,
		To:        toAddr,
		MessageID: messageID,
		Subject:   email.Subject,
		Headers:   headerMap,
		BodyText:  bodyText,
	})
	if err != nil {
		j.Emit("error", err)
		return
	}
	if message != nil && message.Intent != "" {
		message.BodyText = bodyText
		for _, attachment := range email.Attachments {
			message.Attachments = append(message.Attachments, ReceivedAttachment{
				Filename:    firstNonEmpty(attachment.Name, "attachment"),
				ContentType: attachment.Type,
				Size:        attachment.Size,
				BlobID:      attachment.BlobID,
			})
		}
		if message.Intent == "task.dispatch" {
			j.Emit("_autoAck", autoAckPayload{To: fromAddr, TaskID: message.TaskID, MessageID: messageID})
		}
		j.Emit(message.Intent, *message)
		return
	}

	rawInReplyTo := headerMap["in-reply-to"]
	if rawInReplyTo == "" {
		return
	}
	reply := ParsedMessage{
		Intent:    "reply",
		InReplyTo: strings.Trim(strings.ReplaceAll(strings.ReplaceAll(rawInReplyTo, "<", ""), ">", ""), " "),
		MessageID: messageID,
		From:      fromAddr,
		To:        toAddr,
		Subject:   email.Subject,
		BodyText:  bodyText,
	}
	for _, token := range strings.Fields(headerMap["references"]) {
		reply.References = append(reply.References, strings.Trim(strings.ReplaceAll(strings.ReplaceAll(token, "<", ""), ">", ""), " "))
	}
	j.Emit("reply", reply)
}

func (j *JmapPushClient) handleStateChange(payload jmapPushStateChange) {
	accountID, err := j.primaryAccountID()
	if err != nil {
		j.Emit("error", err)
		return
	}
	if payload.Changed[accountID]["Email"] == "" {
		return
	}
	j.mu.Lock()
	emailState := j.emailState
	j.mu.Unlock()
	if emailState == "" {
		if err := j.initEmailState(accountID); err != nil {
			j.Emit("error", err)
		}
		return
	}
	emails, err := j.fetchEmailsSince(accountID, emailState)
	if err != nil {
		j.Emit("error", err)
		return
	}
	for _, email := range emails {
		j.processEmail(email)
	}
}

func (j *JmapPushClient) connect() error {
	j.mu.Lock()
	if j.connecting || !j.running {
		j.mu.Unlock()
		return nil
	}
	j.connecting = true
	j.mu.Unlock()

	session, err := j.fetchSession()
	if err != nil {
		j.mu.Lock()
		j.connecting = false
		j.mu.Unlock()
		j.Emit("error", fmt.Errorf("failed to get JMAP session: %w", err))
		j.startPolling("session fetch failed")
		j.scheduleReconnect()
		return nil
	}
	j.mu.Lock()
	j.session = session
	j.mu.Unlock()

	wsURL := strings.Replace(strings.Replace(j.jmapURL, "https://", "wss://", 1), "http://", "ws://", 1) + "/jmap/ws"
	dialer := websocket.Dialer{
		Subprotocols: []string{"jmap"},
		TLSClientConfig: &tls.Config{
			InsecureSkipVerify: !j.rejectUnauthorized,
			MinVersion:         tls.VersionTLS12,
		},
	}
	headers := http.Header{}
	headers.Set("Authorization", j.authHeader())
	conn, _, err := dialer.Dial(wsURL, headers)
	if err != nil {
		j.mu.Lock()
		j.connecting = false
		j.mu.Unlock()
		j.startPolling(err.Error())
		j.Emit("error", err)
		j.scheduleReconnect()
		return nil
	}

	j.mu.Lock()
	j.conn = conn
	j.connecting = false
	j.connected = true
	j.mu.Unlock()
	j.stopPolling()

	accountID, err := j.primaryAccountID()
	if err == nil {
		j.mu.Lock()
		emailState := j.emailState
		j.mu.Unlock()
		if emailState == "" {
			_ = j.initEmailState(accountID)
		}
	}
	if err := conn.WriteJSON(map[string]any{"@type": "WebSocketPushEnable", "dataTypes": []string{"Email"}, "pushState": nil}); err != nil {
		return err
	}
	j.Emit("connected", nil)

	go j.pingLoop(conn)
	go j.readLoop(conn)
	return nil
}

func (j *JmapPushClient) pingLoop(conn *websocket.Conn) {
	ticker := time.NewTicker(j.pingInterval)
	defer ticker.Stop()
	for range ticker.C {
		j.mu.Lock()
		running := j.running
		current := j.conn
		j.mu.Unlock()
		if !running || current != conn {
			return
		}
		_ = conn.WriteControl(websocket.PingMessage, []byte("ping"), time.Now().Add(5*time.Second))
	}
}

func (j *JmapPushClient) readLoop(conn *websocket.Conn) {
	defer func() {
		j.mu.Lock()
		if j.conn == conn {
			j.conn = nil
			j.connected = false
		}
		running := j.running
		j.mu.Unlock()
		j.startPolling("connection closed")
		j.Emit("disconnected", "connection closed")
		if running {
			j.scheduleReconnect()
		}
	}()

	for {
		_, data, err := conn.ReadMessage()
		if err != nil {
			j.Emit("error", err)
			return
		}
		var payload jmapPushStateChange
		if err := json.Unmarshal(data, &payload); err != nil {
			j.Emit("error", fmt.Errorf("failed to process JMAP push message: %w", err))
			continue
		}
		if payload.Type == "StateChange" {
			j.handleStateChange(payload)
		}
	}
}

func (j *JmapPushClient) scheduleReconnect() {
	j.mu.Lock()
	defer j.mu.Unlock()
	if !j.running || j.reconnectTimer != nil {
		return
	}
	j.reconnectTimer = time.AfterFunc(j.reconnectInterval, func() {
		j.mu.Lock()
		j.reconnectTimer = nil
		j.mu.Unlock()
		_ = j.connect()
	})
}

func (j *JmapPushClient) stopPolling() {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.pollStop != nil {
		select {
		case <-j.pollStop:
		default:
			close(j.pollStop)
		}
		j.pollStop = make(chan struct{})
	}
	j.pollingActive = false
}

func (j *JmapPushClient) startPolling(reason string) {
	j.mu.Lock()
	if !j.running || j.pollingActive {
		j.mu.Unlock()
		return
	}
	if j.pollStop != nil {
		select {
		case <-j.pollStop:
		default:
			close(j.pollStop)
		}
	}
	j.pollStop = make(chan struct{})
	pollStop := j.pollStop
	j.pollingActive = true
	j.mu.Unlock()

	j.Emit("error", fmt.Errorf("JMAP WebSocket unavailable, falling back to polling: %s", reason))
	j.Emit("connected", nil)

	go func() {
		ticker := time.NewTicker(j.reconnectInterval)
		defer ticker.Stop()
		for {
			select {
			case <-pollStop:
				j.mu.Lock()
				j.pollingActive = false
				j.mu.Unlock()
				return
			case <-ticker.C:
				j.mu.Lock()
				running := j.running
				connected := j.connected
				j.mu.Unlock()
				if !running || connected {
					j.mu.Lock()
					j.pollingActive = false
					j.mu.Unlock()
					return
				}
				if err := j.pollOnce(); err != nil {
					j.Emit("error", fmt.Errorf("polling fallback failed: %w", err))
				}
			}
		}
	}()
}

func (j *JmapPushClient) pollOnce() error {
	j.mu.Lock()
	session := j.session
	emailState := j.emailState
	j.mu.Unlock()
	if session == nil {
		nextSession, err := j.fetchSession()
		if err != nil {
			return err
		}
		j.mu.Lock()
		j.session = nextSession
		j.mu.Unlock()
	}
	accountID, err := j.primaryAccountID()
	if err != nil {
		return err
	}
	if emailState == "" {
		emails, err := j.fetchRecentEmails(accountID)
		if err != nil {
			return err
		}
		for _, email := range emails {
			if !j.shouldProcessBootstrapEmail(email) {
				continue
			}
			j.processEmail(email)
		}
		return j.initEmailState(accountID)
	}
	emails, err := j.fetchEmailsSince(accountID, emailState)
	if err != nil {
		return err
	}
	for _, email := range emails {
		j.processEmail(email)
	}
	return nil
}

func (j *JmapPushClient) startSafetySync() {
	go func() {
		ticker := time.NewTicker(j.safetySyncInterval)
		defer ticker.Stop()
		for {
			j.mu.Lock()
			stop := j.safetyStop
			running := j.running
			j.mu.Unlock()
			if !running {
				return
			}
			select {
			case <-stop:
				return
			case <-ticker.C:
				if _, err := j.ReconcileRecentEmails(20, false); err != nil {
					j.Emit("error", fmt.Errorf("safety reconcile failed: %w", err))
				}
			}
		}
	}()
}

func (j *JmapPushClient) DownloadBlob(blobID, filename string) ([]byte, error) {
	j.mu.Lock()
	session := j.session
	j.mu.Unlock()
	if session == nil {
		nextSession, err := j.fetchSession()
		if err != nil {
			return nil, err
		}
		j.mu.Lock()
		j.session = nextSession
		session = nextSession
		j.mu.Unlock()
	}
	accountID, err := j.primaryAccountID()
	if err != nil {
		return nil, err
	}
	downloadURL := session.DownloadURL
	if downloadURL == "" {
		downloadURL = j.jmapURL + "/jmap/download/{accountId}/{blobId}/{name}"
	}
	if filename == "" {
		filename = "attachment"
	}
	replaceTemplateToken := func(input, token, value string) string {
		output := strings.ReplaceAll(input, token, value)
		return strings.ReplaceAll(output, url.PathEscape(token), value)
	}
	downloadURL = replaceTemplateToken(downloadURL, "{accountId}", url.PathEscape(accountID))
	downloadURL = replaceTemplateToken(downloadURL, "{blobId}", url.PathEscape(blobID))
	downloadURL = replaceTemplateToken(downloadURL, "{name}", url.PathEscape(filename))
	downloadURL = replaceTemplateToken(downloadURL, "{type}", url.QueryEscape("application/octet-stream"))
	if parsed, err := url.Parse(downloadURL); err == nil {
		if configured, configErr := url.Parse(j.jmapURL); configErr == nil {
			if parsed.Host == "" {
				downloadURL = configured.ResolveReference(parsed).String()
			} else {
				parsed.Scheme = configured.Scheme
				parsed.Host = configured.Host
				downloadURL = parsed.String()
			}
		}
	}

	var lastErr error
	for attempt := 1; attempt <= 8; attempt++ {
		req, err := http.NewRequest(http.MethodGet, downloadURL, nil)
		if err != nil {
			return nil, err
		}
		req.Header.Set("Authorization", j.authHeader())
		res, err := j.httpClient.Do(req)
		if err != nil {
			lastErr = err
		} else {
			defer res.Body.Close()
			if res.StatusCode >= 200 && res.StatusCode < 300 {
				return io.ReadAll(res.Body)
			}
			lastErr = fmt.Errorf("status=%d", res.StatusCode)
			if res.StatusCode != 404 && res.StatusCode != 429 && res.StatusCode != 503 {
				break
			}
		}
		time.Sleep(minDuration(time.Duration(1<<uint(attempt-1))*time.Second, 15*time.Second))
	}
	return nil, fmt.Errorf("blob download failed for %s: %w", blobID, lastErr)
}

func minDuration(a, b time.Duration) time.Duration {
	if a < b {
		return a
	}
	return b
}

func (j *JmapPushClient) ReconcileRecentEmails(limit int, includeHistorical bool) (int, error) {
	j.mu.Lock()
	session := j.session
	j.mu.Unlock()
	if session == nil {
		nextSession, err := j.fetchSession()
		if err != nil {
			return 0, err
		}
		j.mu.Lock()
		j.session = nextSession
		j.mu.Unlock()
	}
	accountID, err := j.primaryAccountID()
	if err != nil {
		return 0, err
	}
	response, err := j.jmapCall([][]any{{
		"Email/query",
		map[string]any{
			"accountId": accountID,
			"sort":      []map[string]any{{"property": "receivedAt", "isAscending": false}},
			"limit":     limit,
		},
		"qReconcile",
	}})
	if err != nil {
		return 0, err
	}
	result := findMethodResponse(response, "Email/query")
	ids := toStringSlice(result["ids"])
	if len(ids) == 0 {
		return 0, nil
	}
	response, err = j.jmapCall([][]any{{
		"Email/get",
		map[string]any{
			"accountId":           accountID,
			"ids":                 ids,
			"properties":          []string{"id", "subject", "from", "to", "headers", "messageId", "receivedAt", "textBody", "bodyValues", "attachments"},
			"fetchTextBodyValues": true,
			"maxBodyValueBytes":   262144,
		},
		"gReconcile",
	}})
	if err != nil {
		return 0, err
	}
	result = findMethodResponse(response, "Email/get")
	emails, err := mapEmails(result["list"])
	if err != nil {
		return 0, err
	}
	for _, email := range emails {
		if !includeHistorical && !j.shouldProcessBootstrapEmail(email) {
			continue
		}
		j.processEmail(email)
	}
	return len(emails), nil
}
