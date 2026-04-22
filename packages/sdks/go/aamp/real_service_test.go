package aamp

import (
	"fmt"
	"os"
	"sync"
	"testing"
	"time"
)

const (
	realServiceTestFlag        = "AAMP_RUN_REAL_SERVICE_TESTS"
	realServiceHostEnv         = "AAMP_REAL_SERVICE_HOST"
	realServiceDefaultHost     = "https://meshmail.ai"
	realServiceTimeoutEnv      = "AAMP_REAL_SERVICE_TIMEOUT_SECS"
	realServiceDefaultTimeout  = 150 * time.Second
	realServiceReconcilePeriod = 2 * time.Second
)

func realServiceHost() string {
	if value := os.Getenv(realServiceHostEnv); value != "" {
		return value
	}
	return realServiceDefaultHost
}

func realServiceTimeout() time.Duration {
	if value := os.Getenv(realServiceTimeoutEnv); value != "" {
		if duration, err := time.ParseDuration(value + "s"); err == nil {
			return duration
		}
	}
	return realServiceDefaultTimeout
}

func registerMailboxWithRetry(host, slug, description string, rejectUnauthorized bool) (*RegisteredMailboxIdentity, error) {
	var lastErr error
	for attempt := 1; attempt <= 10; attempt++ {
		identity, err := RegisterMailbox(RegisterMailboxOptions{
			AAMPHost:    host,
			Slug:        slug,
			Description: description,
		}, rejectUnauthorized)
		if err == nil {
			return identity, nil
		}
		lastErr = err
		if attempt == 10 {
			break
		}
		time.Sleep(minDuration(time.Duration(1<<uint(attempt-1))*time.Second, 10*time.Second))
	}
	return nil, fmt.Errorf("register mailbox failed after retries: %w", lastErr)
}

func TestRegisterAndExchangeMailOverMeshmail(t *testing.T) {
	if os.Getenv(realServiceTestFlag) != "1" {
		t.Skip("real service tests are disabled")
	}

	host := realServiceHost()
	runID := generateID()[:8]

	dispatcherIdentity, err := registerMailboxWithRetry(
		host,
		"cgd-"+runID,
		"Codex Go real-service integration test dispatcher",
		true,
	)
	if err != nil {
		t.Fatal(err)
	}
	agentIdentity, err := registerMailboxWithRetry(
		host,
		"cga-"+runID,
		"Codex Go real-service integration test agent",
		true,
	)
	if err != nil {
		t.Fatal(err)
	}

	dispatcher, err := NewClient(Config{
		Email:              dispatcherIdentity.Email,
		MailboxToken:       dispatcherIdentity.MailboxToken,
		BaseURL:            host,
		SMTPPassword:       dispatcherIdentity.SMTPPassword,
		ReconnectInterval:  time.Second,
		RejectUnauthorized: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	agent, err := NewClient(Config{
		Email:              agentIdentity.Email,
		MailboxToken:       agentIdentity.MailboxToken,
		BaseURL:            host,
		SMTPPassword:       agentIdentity.SMTPPassword,
		ReconnectInterval:  time.Second,
		RejectUnauthorized: true,
	})
	if err != nil {
		t.Fatal(err)
	}

	var mu sync.Mutex
	var ackReceived bool
	var dispatchReceived bool
	var resultReceived bool
	var dispatchPayload ParsedMessage
	var resultPayload ParsedMessage

	agent.On("task.dispatch", func(payload any) {
		task := payload.(ParsedMessage)
		mu.Lock()
		dispatchReceived = true
		dispatchPayload = task
		mu.Unlock()

		if err := agent.SendResult(SendResultOptions{
			To:        task.From,
			TaskID:    task.TaskID,
			Status:    "completed",
			Output:    "go-real-service-ok",
			InReplyTo: task.MessageID,
			Attachments: []Attachment{{
				Filename:    "real-service.txt",
				ContentType: "text/plain",
				Content:     []byte("go-real-service-blob"),
			}},
		}); err != nil {
			t.Errorf("send result failed: %v", err)
		}
	})
	dispatcher.On("task.ack", func(payload any) {
		mu.Lock()
		defer mu.Unlock()
		ackReceived = true
		_ = payload.(ParsedMessage)
	})
	dispatcher.On("task.result", func(payload any) {
		mu.Lock()
		defer mu.Unlock()
		resultReceived = true
		resultPayload = payload.(ParsedMessage)
	})

	taskID, _, err := dispatcher.SendTask(SendTaskOptions{
		To:       agentIdentity.Email,
		Title:    "Codex Go real-service test " + runID,
		BodyText: "real-service go probe " + runID,
		Priority: "high",
	})
	if err != nil {
		t.Fatal(err)
	}

	deadline := time.Now().Add(realServiceTimeout())
	for time.Now().Before(deadline) {
		mu.Lock()
		done := ackReceived && dispatchReceived && resultReceived
		mu.Unlock()
		if done {
			break
		}
		if _, err := agent.ReconcileRecentEmails(10, false); err != nil {
			t.Logf("agent reconcile failed: %v", err)
		}
		if _, err := dispatcher.ReconcileRecentEmails(10, false); err != nil {
			t.Logf("dispatcher reconcile failed: %v", err)
		}
		time.Sleep(realServiceReconcilePeriod)
	}

	mu.Lock()
	ackOK := ackReceived
	dispatchOK := dispatchReceived
	resultOK := resultReceived
	dispatch := dispatchPayload
	result := resultPayload
	mu.Unlock()

	if !dispatchOK {
		t.Fatal("agent did not receive dispatched task from meshmail.ai")
	}
	if !ackOK {
		t.Fatal("dispatcher did not receive ACK from meshmail.ai")
	}
	if !resultOK {
		t.Fatal("dispatcher did not receive task result from meshmail.ai")
	}

	if dispatch.TaskID != taskID {
		t.Fatalf("unexpected dispatch task id: %s", dispatch.TaskID)
	}
	if result.TaskID != taskID {
		t.Fatalf("unexpected result task id: %s", result.TaskID)
	}
	if result.Status != "completed" || result.Output != "go-real-service-ok" {
		t.Fatalf("unexpected result payload: %#v", result)
	}
	if len(result.Attachments) != 1 {
		t.Fatalf("expected one attachment, got %#v", result.Attachments)
	}

	blob, err := dispatcher.DownloadBlob(result.Attachments[0].BlobID, result.Attachments[0].Filename)
	if err != nil {
		t.Fatal(err)
	}
	if string(blob) != "go-real-service-blob" {
		t.Fatalf("unexpected blob content: %s", string(blob))
	}
}
