package aamp

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
)

type mockAttachment struct {
	BlobID      string
	Filename    string
	ContentType string
	Content     []byte
}

type mockMessage struct {
	MessageID   string
	Subject     string
	Text        string
	FromEmail   string
	ToEmail     string
	Headers     map[string]string
	State       int
	ReceivedAt  string
	Attachments []mockAttachment
}

type mockStream struct {
	StreamID    string         `json:"streamId"`
	TaskID      string         `json:"taskId"`
	Status      string         `json:"status"`
	OwnerEmail  string         `json:"ownerEmail"`
	PeerEmail   string         `json:"peerEmail"`
	CreatedAt   string         `json:"createdAt"`
	OpenedAt    string         `json:"openedAt,omitempty"`
	ClosedAt    string         `json:"closedAt,omitempty"`
	LatestEvent map[string]any `json:"latestEvent,omitempty"`
	Events      []map[string]any
}

type mockState struct {
	mu          sync.Mutex
	appendDelay time.Duration
	current     int
	nextMessage int
	nextBlob    int
	nextStream  int
	messages    []mockMessage
	streams     map[string]*mockStream
}

func newMockState() *mockState {
	return &mockState{streams: map[string]*mockStream{}}
}

func (s *mockState) storeMessage(fromEmail, toEmail, subject, text string, headers map[string]string, attachments []map[string]any) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.current++
	s.nextMessage++
	messageID := fmt.Sprintf("<msg-%d@mock.local>", s.nextMessage)
	msgAttachments := make([]mockAttachment, 0, len(attachments))
	for _, item := range attachments {
		s.nextBlob++
		content, _ := base64.StdEncoding.DecodeString(item["content"].(string))
		msgAttachments = append(msgAttachments, mockAttachment{
			BlobID:      fmt.Sprintf("blob-%d", s.nextBlob),
			Filename:    item["filename"].(string),
			ContentType: item["contentType"].(string),
			Content:     content,
		})
	}
	s.messages = append(s.messages, mockMessage{
		MessageID:   messageID,
		Subject:     subject,
		Text:        text,
		FromEmail:   fromEmail,
		ToEmail:     toEmail,
		Headers:     headers,
		State:       s.current,
		ReceivedAt:  time.Now().UTC().Format(time.RFC3339),
		Attachments: msgAttachments,
	})
	return messageID
}

func (s *mockState) mailboxMessages(email string) []mockMessage {
	s.mu.Lock()
	defer s.mu.Unlock()
	var result []mockMessage
	for _, msg := range s.messages {
		if msg.ToEmail == email {
			result = append(result, msg)
		}
	}
	return result
}

func (s *mockState) getMessage(email, messageID string) *mockMessage {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, msg := range s.messages {
		if msg.ToEmail == email && msg.MessageID == messageID {
			copyMsg := msg
			return &copyMsg
		}
	}
	return nil
}

func (s *mockState) getBlob(email, blobID string) *mockAttachment {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, msg := range s.messages {
		if msg.ToEmail != email {
			continue
		}
		for _, attachment := range msg.Attachments {
			if attachment.BlobID == blobID {
				copyAttachment := attachment
				return &copyAttachment
			}
		}
	}
	for _, msg := range s.messages {
		for _, attachment := range msg.Attachments {
			if attachment.BlobID == blobID {
				copyAttachment := attachment
				return &copyAttachment
			}
		}
	}
	return nil
}

func (s *mockState) createStream(ownerEmail, taskID, peerEmail string) map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, stream := range s.streams {
		if stream.TaskID == taskID && stream.Status != "closed" {
			return map[string]any{
				"streamId":   stream.StreamID,
				"taskId":     stream.TaskID,
				"status":     stream.Status,
				"ownerEmail": stream.OwnerEmail,
				"peerEmail":  stream.PeerEmail,
				"createdAt":  stream.CreatedAt,
			}
		}
	}
	s.nextStream++
	stream := &mockStream{
		StreamID:   fmt.Sprintf("stream-%d", s.nextStream),
		TaskID:     taskID,
		Status:     "created",
		OwnerEmail: ownerEmail,
		PeerEmail:  peerEmail,
		CreatedAt:  time.Now().UTC().Format(time.RFC3339),
	}
	s.streams[stream.StreamID] = stream
	return map[string]any{
		"streamId":   stream.StreamID,
		"taskId":     stream.TaskID,
		"status":     stream.Status,
		"ownerEmail": stream.OwnerEmail,
		"peerEmail":  stream.PeerEmail,
		"createdAt":  stream.CreatedAt,
	}
}

func (s *mockState) appendStreamEvent(streamID, eventType string, payload map[string]any) map[string]any {
	if s.appendDelay > 0 {
		time.Sleep(s.appendDelay)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	stream := s.streams[streamID]
	event := map[string]any{
		"id":        fmt.Sprintf("%s-%d", streamID, len(stream.Events)+1),
		"streamId":  streamID,
		"taskId":    stream.TaskID,
		"seq":       len(stream.Events) + 1,
		"timestamp": time.Now().UTC().Format(time.RFC3339),
		"type":      eventType,
		"payload":   payload,
	}
	stream.Events = append(stream.Events, event)
	stream.LatestEvent = event
	if eventType == "done" {
		stream.Status = "closed"
		stream.ClosedAt = event["timestamp"].(string)
	}
	return event
}

func (s *mockState) closeStream(streamID string, payload map[string]any) map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	stream := s.streams[streamID]
	stream.Status = "closed"
	stream.ClosedAt = time.Now().UTC().Format(time.RFC3339)
	if len(payload) > 0 {
		stream.LatestEvent = map[string]any{
			"id":        fmt.Sprintf("%s-done", streamID),
			"streamId":  streamID,
			"taskId":    stream.TaskID,
			"seq":       len(stream.Events) + 1,
			"timestamp": stream.ClosedAt,
			"type":      "done",
			"payload":   payload,
		}
	}
	return map[string]any{
		"streamId":    stream.StreamID,
		"taskId":      stream.TaskID,
		"status":      stream.Status,
		"ownerEmail":  stream.OwnerEmail,
		"peerEmail":   stream.PeerEmail,
		"createdAt":   stream.CreatedAt,
		"closedAt":    stream.ClosedAt,
		"latestEvent": stream.LatestEvent,
	}
}

func (s *mockState) getStream(taskID, streamID string) (map[string]any, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if streamID != "" {
		stream, ok := s.streams[streamID]
		if !ok {
			return nil, false
		}
		return map[string]any{
			"streamId":    stream.StreamID,
			"taskId":      stream.TaskID,
			"status":      stream.Status,
			"ownerEmail":  stream.OwnerEmail,
			"peerEmail":   stream.PeerEmail,
			"createdAt":   stream.CreatedAt,
			"closedAt":    stream.ClosedAt,
			"latestEvent": stream.LatestEvent,
		}, true
	}
	for _, stream := range s.streams {
		if stream.TaskID == taskID {
			return map[string]any{
				"streamId":    stream.StreamID,
				"taskId":      stream.TaskID,
				"status":      stream.Status,
				"ownerEmail":  stream.OwnerEmail,
				"peerEmail":   stream.PeerEmail,
				"createdAt":   stream.CreatedAt,
				"closedAt":    stream.ClosedAt,
				"latestEvent": stream.LatestEvent,
			}, true
		}
	}
	return nil, false
}

func decodeAuthEmail(header string) string {
	token := strings.TrimPrefix(header, "Basic ")
	decoded, _ := base64.StdEncoding.DecodeString(token)
	return strings.SplitN(string(decoded), ":", 2)[0]
}

func methodCallResponse(name string, payload any, tag string) []any {
	return []any{name, payload, tag}
}

func newMockServer(t *testing.T) (*httptest.Server, *mockState) {
	t.Helper()
	state := newMockState()
	var server *httptest.Server

	mux := http.NewServeMux()
	mux.HandleFunc("/.well-known/aamp", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"protocol": "aamp",
			"version":  "1.1",
			"api":      map[string]any{"url": "/api/aamp"},
			"capabilities": map[string]any{
				"stream": map[string]any{
					"transport":    "sse",
					"createAction": "aamp.stream.create",
					"appendAction": "aamp.stream.append",
					"closeAction":  "aamp.stream.close",
					"getAction":    "aamp.stream.get",
				},
			},
		})
	})
	mux.HandleFunc("/.well-known/jmap", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"primaryAccounts": map[string]any{"urn:ietf:params:jmap:mail": "acc-1"},
			"accounts":        map[string]any{"acc-1": map[string]any{"name": "mock"}},
			"downloadUrl":     server.URL + "/jmap/download/{accountId}/{blobId}/{name}",
		})
	})
	mux.HandleFunc("/api/aamp", func(w http.ResponseWriter, r *http.Request) {
		authEmail := decodeAuthEmail(r.Header.Get("Authorization"))
		action := r.URL.Query().Get("action")
		switch r.Method + " " + action {
		case "GET aamp.stream.get":
			stream, ok := state.getStream(r.URL.Query().Get("taskId"), r.URL.Query().Get("streamId"))
			if !ok {
				http.NotFound(w, r)
				return
			}
			_ = json.NewEncoder(w).Encode(stream)
		case "POST aamp.mailbox.send":
			var payload struct {
				To          string            `json:"to"`
				Subject     string            `json:"subject"`
				Text        string            `json:"text"`
				AAMPHeaders map[string]string `json:"aampHeaders"`
				Attachments []map[string]any  `json:"attachments"`
			}
			_ = json.NewDecoder(r.Body).Decode(&payload)
			messageID := state.storeMessage(authEmail, payload.To, payload.Subject, payload.Text, payload.AAMPHeaders, payload.Attachments)
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "messageId": messageID})
		case "POST aamp.stream.create":
			var payload struct {
				TaskID    string `json:"taskId"`
				PeerEmail string `json:"peerEmail"`
			}
			_ = json.NewDecoder(r.Body).Decode(&payload)
			_ = json.NewEncoder(w).Encode(state.createStream(authEmail, payload.TaskID, payload.PeerEmail))
		case "POST aamp.stream.append":
			var payload struct {
				StreamID string         `json:"streamId"`
				Type     string         `json:"type"`
				Payload  map[string]any `json:"payload"`
			}
			_ = json.NewDecoder(r.Body).Decode(&payload)
			_ = json.NewEncoder(w).Encode(state.appendStreamEvent(payload.StreamID, payload.Type, payload.Payload))
		case "POST aamp.stream.close":
			var payload struct {
				StreamID string         `json:"streamId"`
				Payload  map[string]any `json:"payload"`
			}
			_ = json.NewDecoder(r.Body).Decode(&payload)
			_ = json.NewEncoder(w).Encode(state.closeStream(payload.StreamID, payload.Payload))
		default:
			http.NotFound(w, r)
		}
	})
	mux.HandleFunc("/jmap/", func(w http.ResponseWriter, r *http.Request) {
		authEmail := decodeAuthEmail(r.Header.Get("Authorization"))
		var payload struct {
			MethodCalls [][]json.RawMessage `json:"methodCalls"`
		}
		_ = json.NewDecoder(r.Body).Decode(&payload)
		var responses [][]any
		for _, call := range payload.MethodCalls {
			var methodName string
			var args map[string]any
			var tag string
			_ = json.Unmarshal(call[0], &methodName)
			_ = json.Unmarshal(call[1], &args)
			_ = json.Unmarshal(call[2], &tag)
			switch methodName {
			case "Email/get":
				ids := toStringSlice(args["ids"])
				if len(ids) == 0 {
					responses = append(responses, methodCallResponse(methodName, map[string]any{"state": fmt.Sprintf("%d", state.current), "list": []any{}}, tag))
					continue
				}
				var list []map[string]any
				for _, id := range ids {
					msg := state.getMessage(authEmail, id)
					if msg == nil {
						continue
					}
					var attachments []map[string]any
					for _, item := range msg.Attachments {
						attachments = append(attachments, map[string]any{
							"blobId": item.BlobID,
							"type":   item.ContentType,
							"name":   item.Filename,
							"size":   len(item.Content),
						})
					}
					headers := make([]map[string]any, 0, len(msg.Headers))
					for key, value := range msg.Headers {
						headers = append(headers, map[string]any{"name": key, "value": value})
					}
					list = append(list, map[string]any{
						"id":          msg.MessageID,
						"subject":     msg.Subject,
						"from":        []map[string]any{{"email": msg.FromEmail}},
						"to":          []map[string]any{{"email": msg.ToEmail}},
						"messageId":   []string{msg.MessageID},
						"headers":     headers,
						"receivedAt":  msg.ReceivedAt,
						"textBody":    []map[string]any{{"partId": "body"}},
						"bodyValues":  map[string]any{"body": map[string]any{"value": msg.Text}},
						"attachments": attachments,
					})
				}
				responses = append(responses, methodCallResponse(methodName, map[string]any{"state": fmt.Sprintf("%d", state.current), "list": list}, tag))
			case "Email/query":
				messages := state.mailboxMessages(authEmail)
				slices.Reverse(messages)
				limit := 20
				if raw, ok := args["limit"].(float64); ok {
					limit = int(raw)
				}
				var ids []string
				for index, message := range messages {
					if index >= limit {
						break
					}
					ids = append(ids, message.MessageID)
				}
				responses = append(responses, methodCallResponse(methodName, map[string]any{"ids": ids}, tag))
			case "Email/changes":
				sinceState := 0
				if raw, ok := args["sinceState"].(string); ok {
					fmt.Sscanf(raw, "%d", &sinceState)
				}
				var created []string
				for _, message := range state.mailboxMessages(authEmail) {
					if message.State > sinceState {
						created = append(created, message.MessageID)
					}
				}
				responses = append(responses, methodCallResponse(methodName, map[string]any{"created": created, "newState": fmt.Sprintf("%d", state.current)}, tag))
			default:
				responses = append(responses, methodCallResponse("error", map[string]any{"type": "unknownMethod"}, tag))
			}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"methodResponses": responses})
	})
	mux.HandleFunc("/jmap/download/", func(w http.ResponseWriter, r *http.Request) {
		authEmail := decodeAuthEmail(r.Header.Get("Authorization"))
		var attachment *mockAttachment
		for _, message := range state.mailboxMessages(authEmail) {
			for _, item := range message.Attachments {
				if strings.Contains(r.URL.Path, item.BlobID) {
					copyAttachment := item
					attachment = &copyAttachment
					break
				}
			}
		}
		if attachment == nil {
			for _, message := range state.messages {
				for _, item := range message.Attachments {
					if strings.Contains(r.URL.Path, item.BlobID) {
						copyAttachment := item
						attachment = &copyAttachment
						break
					}
				}
			}
		}
		if attachment == nil {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", attachment.ContentType)
		_, _ = w.Write(attachment.Content)
	})
	server = httptest.NewServer(mux)
	return server, state
}

func waitFor(t *testing.T, timeout time.Duration, fn func() bool, label string) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if fn() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", label)
}

func TestClientEndToEnd(t *testing.T) {
	server, _ := newMockServer(t)
	defer server.Close()

	dispatcher, err := FromMailboxIdentity(MailboxIdentityConfig{
		Email:              "dispatcher@mesh.local",
		SMTPPassword:       "dispatcher-pass",
		BaseURL:            server.URL,
		ReconnectInterval:  100 * time.Millisecond,
		RejectUnauthorized: false,
	})
	if err != nil {
		t.Fatal(err)
	}
	agent, err := FromMailboxIdentity(MailboxIdentityConfig{
		Email:              "agent@mesh.local",
		SMTPPassword:       "agent-pass",
		BaseURL:            server.URL,
		ReconnectInterval:  100 * time.Millisecond,
		RejectUnauthorized: false,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer dispatcher.Disconnect()
	defer agent.Disconnect()

	var mu sync.Mutex
	var ackReceived bool
	var streamReceived bool
	var resultReceived bool
	var resultPayload ParsedMessage
	var streamPayload ParsedMessage

	agent.On("task.dispatch", func(payload any) {
		task := payload.(ParsedMessage)
		stream, err := agent.CreateStream(CreateStreamOptions{TaskID: task.TaskID, PeerEmail: task.From})
		if err != nil {
			t.Errorf("create stream failed: %v", err)
			return
		}
		if err := agent.SendStreamOpened(task.From, task.TaskID, stream.StreamID, task.MessageID); err != nil {
			t.Errorf("send stream opened failed: %v", err)
			return
		}
		if _, err := agent.AppendStreamEvent(AppendStreamEventOptions{
			StreamID: stream.StreamID,
			Type:     "status",
			Payload:  map[string]any{"stage": "running"},
		}); err != nil {
			t.Errorf("append stream failed: %v", err)
			return
		}
		if _, err := agent.CloseStream(CloseStreamOptions{
			StreamID: stream.StreamID,
			Payload:  map[string]any{"stage": "done"},
		}); err != nil {
			t.Errorf("close stream failed: %v", err)
			return
		}
		if err := agent.SendResult(SendResultOptions{
			To:        task.From,
			TaskID:    task.TaskID,
			Status:    "completed",
			Output:    "processed",
			InReplyTo: task.MessageID,
			Attachments: []Attachment{{
				Filename:    "report.txt",
				ContentType: "text/plain",
				Content:     []byte("integration-ok"),
			}},
		}); err != nil {
			t.Errorf("send result failed: %v", err)
			return
		}
	})
	dispatcher.On("task.ack", func(payload any) {
		mu.Lock()
		defer mu.Unlock()
		ackReceived = true
		_ = payload.(ParsedMessage)
	})
	dispatcher.On("task.stream.opened", func(payload any) {
		mu.Lock()
		defer mu.Unlock()
		streamReceived = true
		streamPayload = payload.(ParsedMessage)
	})
	dispatcher.On("task.result", func(payload any) {
		mu.Lock()
		defer mu.Unlock()
		resultReceived = true
		resultPayload = payload.(ParsedMessage)
	})

	if err := dispatcher.Connect(); err != nil {
		t.Fatal(err)
	}
	if err := agent.Connect(); err != nil {
		t.Fatal(err)
	}
	time.Sleep(300 * time.Millisecond)

	taskID, _, err := dispatcher.SendTask(SendTaskOptions{
		To:       "agent@mesh.local",
		Title:    "Integration test",
		BodyText: "Please handle this task.",
		Priority: "high",
	})
	if err != nil {
		t.Fatal(err)
	}

	waitFor(t, 5*time.Second, func() bool {
		mu.Lock()
		defer mu.Unlock()
		return ackReceived
	}, "ack")
	waitFor(t, 5*time.Second, func() bool {
		mu.Lock()
		defer mu.Unlock()
		return streamReceived
	}, "stream opened")
	waitFor(t, 5*time.Second, func() bool {
		mu.Lock()
		defer mu.Unlock()
		return resultReceived
	}, "result")

	mu.Lock()
	stream := streamPayload
	result := resultPayload
	mu.Unlock()

	if stream.TaskID != taskID {
		t.Fatalf("unexpected stream task id: %s", stream.TaskID)
	}
	if result.TaskID != taskID || result.Status != "completed" || result.Output != "processed" {
		t.Fatalf("unexpected result payload: %#v", result)
	}
	if len(result.Attachments) != 1 {
		t.Fatalf("expected one attachment, got %#v", result.Attachments)
	}
	blob, err := dispatcher.DownloadBlob(result.Attachments[0].BlobID, "report.txt")
	if err != nil {
		t.Fatal(err)
	}
	if string(blob) != "integration-ok" {
		t.Fatalf("unexpected blob content: %s", string(blob))
	}
	streamState, err := dispatcher.GetTaskStream(taskID, "")
	if err != nil {
		t.Fatal(err)
	}
	if streamState.Status != "closed" {
		t.Fatalf("unexpected stream status: %#v", streamState)
	}
	if stage := streamState.LatestEvent.Payload["stage"]; stage != "done" {
		t.Fatalf("unexpected latest event payload: %#v", streamState.LatestEvent)
	}
}

func TestClientAppendStreamEventSerializesAndCoalescesTextDeltaPerStream(t *testing.T) {
	server, state := newMockServer(t)
	defer server.Close()
	state.appendDelay = 50 * time.Millisecond

	client, err := FromMailboxIdentity(MailboxIdentityConfig{
		Email:              "agent@mesh.local",
		SMTPPassword:       "agent-pass",
		BaseURL:            server.URL,
		ReconnectInterval:  100 * time.Millisecond,
		RejectUnauthorized: false,
	})
	if err != nil {
		t.Fatal(err)
	}

	stream, err := client.CreateStream(CreateStreamOptions{
		TaskID:    "task-stream-ordering",
		PeerEmail: "dispatcher@mesh.local",
	})
	if err != nil {
		t.Fatal(err)
	}

	tokens := make([]string, 26)
	for index := range tokens {
		tokens[index] = string(rune('A' + index))
	}

	var wg sync.WaitGroup
	firstToken := tokens[0]
	wg.Add(1)
	go func(text string) {
		defer wg.Done()
		if _, err := client.AppendStreamEvent(AppendStreamEventOptions{
			StreamID: stream.StreamID,
			Type:     "text.delta",
			Payload:  map[string]any{"text": text},
		}); err != nil {
			t.Errorf("append stream failed: %v", err)
		}
	}(firstToken)
	time.Sleep(10 * time.Millisecond)

	releases := make([]chan struct{}, 0, len(tokens)-1)
	for _, token := range tokens[1:] {
		release := make(chan struct{})
		releases = append(releases, release)
		wg.Add(1)
		go func(text string, gate <-chan struct{}) {
			defer wg.Done()
			<-gate
			if _, err := client.AppendStreamEvent(AppendStreamEventOptions{
				StreamID: stream.StreamID,
				Type:     "text.delta",
				Payload:  map[string]any{"text": text},
			}); err != nil {
				t.Errorf("append stream failed: %v", err)
			}
		}(token, release)
	}
	for _, release := range releases {
		close(release)
		time.Sleep(2 * time.Millisecond)
	}
	wg.Wait()

	state.mu.Lock()
	events := slices.Clone(state.streams[stream.StreamID].Events)
	state.mu.Unlock()

	if len(events) == 0 {
		t.Fatal("expected at least one stream event")
	}
	if len(events) >= len(tokens) {
		t.Fatalf("expected coalesced text.delta events, got %d events for %d tokens", len(events), len(tokens))
	}

	var builder strings.Builder
	for _, event := range events {
		builder.WriteString(fmt.Sprint(event["payload"].(map[string]any)["text"]))
	}

	if builder.String() != strings.Join(tokens, "") {
		t.Fatalf("expected received text %q, got %q", strings.Join(tokens, ""), builder.String())
	}
}
