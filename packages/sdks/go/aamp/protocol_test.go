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
