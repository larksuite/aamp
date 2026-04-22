package aamp

import (
	"bytes"
	"crypto/rand"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"mime/quotedprintable"
	"net/http"
	"net/smtp"
	"net/url"
	"strings"
	"time"
)

type SmtpSender struct {
	Host               string
	Port               int
	User               string
	Password           string
	HTTPSendBaseURL    string
	AuthToken          string
	Secure             bool
	RejectUnauthorized bool
	HTTPClient         *http.Client
	apiURL             string
}

func DeriveMailboxServiceDefaults(email, baseURL string) (smtpHost string, httpBaseURL string) {
	domain := ""
	if parts := strings.SplitN(email, "@", 2); len(parts) == 2 {
		domain = strings.TrimSpace(parts[1])
	}
	if strings.TrimSpace(baseURL) != "" {
		httpBaseURL = strings.TrimSpace(baseURL)
	} else if domain != "" {
		httpBaseURL = "https://" + domain
	}
	smtpHost = domain
	if smtpHost == "" {
		parsed, err := url.Parse(httpBaseURL)
		if err == nil {
			smtpHost = parsed.Hostname()
		}
	}
	if smtpHost == "" {
		smtpHost = "localhost"
	}
	return smtpHost, httpBaseURL
}

func NewSmtpSender(host string, port int, user, password, httpBaseURL, authToken string, rejectUnauthorized bool) *SmtpSender {
	return &SmtpSender{
		Host:               host,
		Port:               port,
		User:               user,
		Password:           password,
		HTTPSendBaseURL:    httpBaseURL,
		AuthToken:          authToken,
		RejectUnauthorized: rejectUnauthorized,
		HTTPClient: &http.Client{
			Timeout: 30 * time.Second,
		},
	}
}

func (s *SmtpSender) senderDomain() string {
	parts := strings.SplitN(s.User, "@", 2)
	if len(parts) != 2 {
		return ""
	}
	return strings.ToLower(parts[1])
}

func recipientDomain(email string) string {
	parts := strings.SplitN(email, "@", 2)
	if len(parts) != 2 {
		return ""
	}
	return strings.ToLower(parts[1])
}

func (s *SmtpSender) shouldUseHTTPFallback(to string) bool {
	return s.HTTPSendBaseURL != "" && s.AuthToken != "" && s.senderDomain() != "" && s.senderDomain() == recipientDomain(to)
}

func (s *SmtpSender) tlsConfig() *tls.Config {
	return &tls.Config{
		ServerName:         s.Host,
		InsecureSkipVerify: !s.RejectUnauthorized,
		MinVersion:         tls.VersionTLS12,
	}
}

func (s *SmtpSender) resolveAAMPAPIURL() (string, error) {
	if s.apiURL != "" {
		return s.apiURL, nil
	}
	if s.HTTPSendBaseURL == "" {
		return "", fmt.Errorf("HTTP send fallback is not configured")
	}
	discovery, err := DiscoverAampService(s.HTTPSendBaseURL, s.RejectUnauthorized)
	if err != nil {
		return "", err
	}
	if discovery.API == nil || discovery.API.URL == "" {
		return "", fmt.Errorf("AAMP discovery did not return api.url")
	}
	base := strings.TrimRight(s.HTTPSendBaseURL, "/") + "/"
	baseURL, err := url.Parse(base)
	if err != nil {
		return "", err
	}
	parsed, err := url.Parse(discovery.API.URL)
	if err != nil {
		return "", err
	}
	s.apiURL = baseURL.ResolveReference(parsed).String()
	return s.apiURL, nil
}

func (s *SmtpSender) sendViaHTTP(to, subject, text string, aampHeaders map[string]string, attachments []Attachment) (string, error) {
	if s.AuthToken == "" {
		return "", fmt.Errorf("HTTP send fallback is not configured")
	}
	apiURL, err := s.resolveAAMPAPIURL()
	if err != nil {
		return "", err
	}
	parsed, err := url.Parse(apiURL)
	if err != nil {
		return "", err
	}
	query := parsed.Query()
	query.Set("action", "aamp.mailbox.send")
	parsed.RawQuery = query.Encode()

	type httpAttachment struct {
		Filename    string `json:"filename"`
		ContentType string `json:"contentType"`
		Content     string `json:"content"`
	}
	payload := struct {
		To          string            `json:"to"`
		Subject     string            `json:"subject"`
		Text        string            `json:"text"`
		AAMPHeaders map[string]string `json:"aampHeaders"`
		Attachments []httpAttachment  `json:"attachments,omitempty"`
	}{
		To:          to,
		Subject:     subject,
		Text:        text,
		AAMPHeaders: aampHeaders,
	}
	for _, attachment := range attachments {
		payload.Attachments = append(payload.Attachments, httpAttachment{
			Filename:    attachment.Filename,
			ContentType: attachment.ContentType,
			Content:     base64.StdEncoding.EncodeToString(attachment.Content),
		})
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	req, err := http.NewRequest(http.MethodPost, parsed.String(), bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Basic "+s.AuthToken)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	res, err := s.HTTPClient.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		payload, _ := io.ReadAll(res.Body)
		return "", fmt.Errorf("HTTP send failed: %s", strings.TrimSpace(string(payload)))
	}
	var response struct {
		MessageID string `json:"messageId"`
	}
	if err := json.NewDecoder(res.Body).Decode(&response); err != nil {
		return "", err
	}
	return response.MessageID, nil
}

func sanitizeHeader(value string) string {
	replacer := strings.NewReplacer("\r", " ", "\n", " ")
	return strings.TrimSpace(replacer.Replace(value))
}

func generateID() string {
	payload := make([]byte, 16)
	if _, err := rand.Read(payload); err != nil {
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	return fmt.Sprintf("%x", payload)
}

func makeMessageID(domain string) string {
	if domain == "" {
		domain = "localhost"
	}
	return fmt.Sprintf("<%s@%s>", generateID(), domain)
}

func writeTextPart(buffer *bytes.Buffer, body string) {
	writer := quotedprintable.NewWriter(buffer)
	_, _ = writer.Write([]byte(body))
	_ = writer.Close()
}

func splitBase64(value string) []string {
	lines := []string{}
	for len(value) > 76 {
		lines = append(lines, value[:76])
		value = value[76:]
	}
	if value != "" {
		lines = append(lines, value)
	}
	return lines
}

func buildMIMEMessage(from, to, subject, body, messageID, inReplyTo string, headers map[string]string, attachments []Attachment) string {
	var buffer bytes.Buffer
	writeHeader := func(key, value string) {
		buffer.WriteString(key)
		buffer.WriteString(": ")
		buffer.WriteString(value)
		buffer.WriteString("\r\n")
	}

	writeHeader("From", from)
	writeHeader("To", to)
	writeHeader("Subject", sanitizeHeader(subject))
	writeHeader("Message-ID", messageID)
	if inReplyTo != "" {
		writeHeader("In-Reply-To", inReplyTo)
		writeHeader("References", inReplyTo)
	}
	for key, value := range headers {
		writeHeader(key, value)
	}
	writeHeader("MIME-Version", "1.0")

	if len(attachments) == 0 {
		writeHeader("Content-Type", `text/plain; charset="utf-8"`)
		writeHeader("Content-Transfer-Encoding", "quoted-printable")
		buffer.WriteString("\r\n")
		writeTextPart(&buffer, body)
		buffer.WriteString("\r\n")
		return buffer.String()
	}

	boundary := "aamp_" + generateID()
	writeHeader("Content-Type", fmt.Sprintf(`multipart/mixed; boundary="%s"`, boundary))
	buffer.WriteString("\r\n")
	buffer.WriteString("--" + boundary + "\r\n")
	buffer.WriteString("Content-Type: text/plain; charset=\"utf-8\"\r\n")
	buffer.WriteString("Content-Transfer-Encoding: quoted-printable\r\n\r\n")
	writeTextPart(&buffer, body)
	buffer.WriteString("\r\n")

	for _, attachment := range attachments {
		buffer.WriteString("--" + boundary + "\r\n")
		buffer.WriteString(fmt.Sprintf("Content-Type: %s\r\n", attachment.ContentType))
		buffer.WriteString("Content-Transfer-Encoding: base64\r\n")
		buffer.WriteString(fmt.Sprintf("Content-Disposition: attachment; filename=\"%s\"\r\n\r\n", attachment.Filename))
		for _, line := range splitBase64(base64.StdEncoding.EncodeToString(attachment.Content)) {
			buffer.WriteString(line)
			buffer.WriteString("\r\n")
		}
	}

	buffer.WriteString("--" + boundary + "--\r\n")
	return buffer.String()
}

func (s *SmtpSender) sendSMTP(to, subject, text, inReplyTo string, aampHeaders map[string]string, attachments []Attachment) (string, error) {
	messageID := makeMessageID(s.senderDomain())
	message := buildMIMEMessage(s.User, to, subject, text, messageID, inReplyTo, aampHeaders, attachments)
	address := fmt.Sprintf("%s:%d", s.Host, s.Port)

	var client *smtp.Client
	var err error
	if s.Secure {
		conn, dialErr := tls.Dial("tcp", address, s.tlsConfig())
		if dialErr != nil {
			return "", dialErr
		}
		client, err = smtp.NewClient(conn, s.Host)
	} else {
		client, err = smtp.Dial(address)
	}
	if err != nil {
		return "", err
	}
	defer client.Close()

	_ = client.Hello("localhost")
	if !s.Secure {
		if ok, _ := client.Extension("STARTTLS"); ok {
			if err := client.StartTLS(s.tlsConfig()); err != nil {
				return "", err
			}
		}
	}
	if ok, _ := client.Extension("AUTH"); ok {
		auth := smtp.PlainAuth("", s.User, s.Password, s.Host)
		if err := client.Auth(auth); err != nil {
			return "", err
		}
	}
	if err := client.Mail(s.User); err != nil {
		return "", err
	}
	if err := client.Rcpt(to); err != nil {
		return "", err
	}
	writer, err := client.Data()
	if err != nil {
		return "", err
	}
	if _, err := writer.Write([]byte(message)); err != nil {
		return "", err
	}
	if err := writer.Close(); err != nil {
		return "", err
	}
	if err := client.Quit(); err != nil {
		return "", err
	}
	return messageID, nil
}

func (s *SmtpSender) dispatch(to, subject, text, inReplyTo string, aampHeaders map[string]string, attachments []Attachment) (string, error) {
	if s.shouldUseHTTPFallback(to) {
		return s.sendViaHTTP(to, subject, text, aampHeaders, attachments)
	}
	return s.sendSMTP(to, subject, text, inReplyTo, aampHeaders, attachments)
}

func (s *SmtpSender) SendTask(opts SendTaskOptions) (string, string, error) {
	taskID := opts.TaskID
	if taskID == "" {
		taskID = generateID()
	}
	priority := firstNonEmpty(opts.Priority, "normal")
	headers := BuildDispatchHeaders(taskID, priority, opts.ExpiresAt, opts.ContextLinks, opts.DispatchContext, opts.ParentTaskID)

	parts := []string{
		"Task: " + opts.Title,
		"Task ID: " + taskID,
		"Priority: " + priority,
		"Expires At: " + firstNonEmpty(opts.ExpiresAt, "none"),
	}
	if len(opts.ContextLinks) > 0 {
		context := "Context:\n"
		for _, link := range opts.ContextLinks {
			context += "  " + link + "\n"
		}
		parts = append(parts, strings.TrimRight(context, "\n"))
	}
	if strings.TrimSpace(opts.BodyText) != "" {
		parts = append(parts, opts.BodyText)
	}
	parts = append(parts, "", "--- This email was sent by AAMP. Reply directly to submit your result. ---")
	body := strings.Join(parts, "\n")
	messageID, err := s.dispatch(opts.To, "[AAMP Task] "+sanitizeHeader(opts.Title), body, "", headers, opts.Attachments)
	return taskID, messageID, err
}

func (s *SmtpSender) SendResult(opts SendResultOptions) error {
	headers := BuildResultHeaders(opts.TaskID, opts.Status, opts.ErrorMsg, opts.StructuredResult)
	parts := []string{"AAMP Task Result", "", "Task ID: " + opts.TaskID, "Status: " + opts.Status, "", "Output:", opts.Output}
	if opts.ErrorMsg != "" {
		parts = append(parts, "\nError: "+opts.ErrorMsg)
	}
	_, err := s.dispatch(opts.To, fmt.Sprintf("[AAMP Result] Task %s - %s", opts.TaskID, opts.Status), strings.Join(parts, "\n"), opts.InReplyTo, headers, opts.Attachments)
	return err
}

func (s *SmtpSender) SendHelp(opts SendHelpOptions) error {
	headers := BuildHelpHeaders(opts.TaskID, opts.SuggestedOptions)
	parts := []string{
		"AAMP Task Help Request",
		"",
		"Task ID: " + opts.TaskID,
		"",
		"Question: " + opts.Question,
		"",
		"Blocked reason: " + opts.BlockedReason,
	}
	if len(opts.SuggestedOptions) > 0 {
		lines := []string{"", "Suggested options:"}
		for index, option := range opts.SuggestedOptions {
			lines = append(lines, fmt.Sprintf("  %d. %s", index+1, option))
		}
		parts = append(parts, strings.Join(lines, "\n"))
	}
	_, err := s.dispatch(opts.To, fmt.Sprintf("[AAMP Help] Task %s needs assistance", opts.TaskID), strings.Join(parts, "\n"), opts.InReplyTo, headers, opts.Attachments)
	return err
}

func (s *SmtpSender) SendCancel(opts SendCancelOptions) error {
	body := firstNonEmpty(opts.BodyText, "The dispatcher cancelled this task.")
	_, err := s.dispatch(opts.To, "[AAMP Cancel] Task "+opts.TaskID, body, opts.InReplyTo, BuildCancelHeaders(opts.TaskID), nil)
	return err
}

func (s *SmtpSender) SendAck(to, taskID, inReplyTo string) error {
	_, err := s.dispatch(to, "[AAMP ACK] Task "+taskID, "", inReplyTo, BuildAckHeaders(taskID), nil)
	return err
}

func (s *SmtpSender) SendStreamOpened(to, taskID, streamID, inReplyTo string) error {
	body := fmt.Sprintf("AAMP task stream is ready.\n\nTask ID: %s\nStream ID: %s", taskID, streamID)
	_, err := s.dispatch(to, "[AAMP Stream] Task "+taskID, body, inReplyTo, BuildStreamOpenedHeaders(taskID, streamID), nil)
	return err
}

func (s *SmtpSender) SendCardQuery(opts SendCardQueryOptions) (string, string, error) {
	taskID := opts.TaskID
	if taskID == "" {
		taskID = generateID()
	}
	bodyText := firstNonEmpty(strings.TrimSpace(opts.BodyText), "Please share your agent card and capability details.")
	messageID, err := s.dispatch(opts.To, "[AAMP Card Query] "+taskID, bodyText, opts.InReplyTo, BuildCardQueryHeaders(taskID), nil)
	return taskID, messageID, err
}

func (s *SmtpSender) SendCardResponse(opts SendCardResponseOptions) error {
	_, err := s.dispatch(opts.To, "[AAMP Card] "+sanitizeHeader(opts.Summary), opts.BodyText, opts.InReplyTo, BuildCardResponseHeaders(opts.TaskID, opts.Summary), nil)
	return err
}

func mustParseURL(value string) *url.URL {
	parsed, _ := url.Parse(value)
	return parsed
}
