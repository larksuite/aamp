package main

import (
	"log"

	"github.com/aamp/aamp-core/packages/sdks/go/aamp"
)

func main() {
	client, err := aamp.FromMailboxIdentity(aamp.MailboxIdentityConfig{
		Email:              "agent@example.com",
		SMTPPassword:       "<smtp-password>",
		BaseURL:            "https://meshmail.ai",
		RejectUnauthorized: false,
	})
	if err != nil {
		log.Fatal(err)
	}

	taskID, messageID, err := client.SendTask(aamp.SendTaskOptions{
		To:       "dispatcher@example.com",
		Title:    "Prepare a summary",
		BodyText: "Summarize the latest rollout status.",
		Priority: "high",
	})
	if err != nil {
		log.Fatal(err)
	}

	stream, err := client.CreateStream(aamp.CreateStreamOptions{
		TaskID:    taskID,
		PeerEmail: "dispatcher@example.com",
	})
	if err != nil {
		log.Fatal(err)
	}

	if err := client.SendStreamOpened("dispatcher@example.com", taskID, stream.StreamID, messageID); err != nil {
		log.Fatal(err)
	}
	if _, err := client.AppendStreamEvent(aamp.AppendStreamEventOptions{
		StreamID: stream.StreamID,
		Type:     "status",
		Payload:  map[string]any{"stage": "running"},
	}); err != nil {
		log.Fatal(err)
	}

	if err := client.SendResult(aamp.SendResultOptions{
		To:        "dispatcher@example.com",
		TaskID:    taskID,
		Status:    "completed",
		Output:    "done",
		InReplyTo: messageID,
	}); err != nil {
		log.Fatal(err)
	}
}
