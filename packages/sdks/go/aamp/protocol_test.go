package aamp

import "testing"

func TestDispatchContextRoundTrip(t *testing.T) {
	encoded := SerializeDispatchContextHeader(map[string]string{
		"project_key": "proj 123",
		"user_key":    "alice",
	})
	if encoded != "project_key=proj+123; user_key=alice" && encoded != "user_key=alice; project_key=proj+123" {
		t.Fatalf("unexpected encoded value: %s", encoded)
	}
	decoded := ParseDispatchContextHeader(encoded)
	if decoded["project_key"] != "proj 123" || decoded["user_key"] != "alice" {
		t.Fatalf("unexpected decoded payload: %#v", decoded)
	}
}

func TestDispatchSessionKeyRoundTrip(t *testing.T) {
	headers := BuildDispatchHeaders("task-1", "normal", "", "sess-1", nil, "")
	if headers[HeaderSessionKey] != "sess-1" {
		t.Fatalf("expected session key header to be set, got %q", headers[HeaderSessionKey])
	}
	message, err := ParseAampHeaders(EmailMetadata{
		From:      "dispatcher@example.com",
		To:        "agent@example.com",
		MessageID: "<msg-1@example.com>",
		Subject:   "[AAMP Task] Do something",
		Headers:   headers,
	})
	if err != nil {
		t.Fatalf("unexpected parse error: %v", err)
	}
	if message == nil {
		t.Fatal("expected parsed message")
	}
	if message.SessionKey != "sess-1" {
		t.Fatalf("expected parsed session key %q, got %q", "sess-1", message.SessionKey)
	}
}

func TestDispatchSessionKeyEmpty(t *testing.T) {
	headers := BuildDispatchHeaders("task-1", "normal", "", "", nil, "")
	if _, ok := headers[HeaderSessionKey]; ok {
		t.Fatalf("expected no session key header for empty value")
	}
	message, err := ParseAampHeaders(EmailMetadata{
		From:    "dispatcher@example.com",
		To:      "agent@example.com",
		Subject: "[AAMP Task] Do something",
		Headers: headers,
	})
	if err != nil {
		t.Fatalf("unexpected parse error: %v", err)
	}
	if message == nil {
		t.Fatal("expected parsed message")
	}
	if message.SessionKey != "" {
		t.Fatalf("expected empty session key, got %q", message.SessionKey)
	}
}

func TestDispatchSessionKeyTrimmed(t *testing.T) {
	headers := BuildDispatchHeaders("task-1", "normal", "", "  sess-trim  ", nil, "")
	if headers[HeaderSessionKey] != "sess-trim" {
		t.Fatalf("expected trimmed session key %q, got %q", "sess-trim", headers[HeaderSessionKey])
	}
}

func TestParseTaskResult(t *testing.T) {
	headers := BuildResultHeaders("task-2", "completed", "", []StructuredResultField{
		{FieldKey: "summary", FieldTypeKey: "text", Value: "done"},
	})
	message, err := ParseAampHeaders(EmailMetadata{
		From:      "agent@example.com",
		To:        "dispatcher@example.com",
		MessageID: "<msg-2@example.com>",
		Subject:   "[AAMP Result] Task task-2 - completed",
		BodyText:  "Output:\ndone",
		Headers:   headers,
	})
	if err != nil {
		t.Fatalf("unexpected parse error: %v", err)
	}
	if message == nil {
		t.Fatal("expected parsed message")
	}
	if message.Intent != "task.result" || message.Output != "done" || message.TaskID != "task-2" {
		t.Fatalf("unexpected parsed message: %#v", message)
	}
}
