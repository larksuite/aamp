# aamp-sdk-go

Go SDK for AAMP.

This SDK now includes the same core runtime shape as the Node.js SDK:

- AAMP discovery and mailbox registration
- directory query and profile updates
- realtime stream create / append / get / close
- AAMP header builders and parsers
- SMTP sending for `task.dispatch`, `task.result`, `task.cancel`, `task.help_needed`, `task.stream.opened`, and `card.*`
- JMAP WebSocket push reception with polling fallback
- attachment blob download
- recent mailbox reconciliation as a safety net

## Install

```bash
cd packages/sdks/go
go test ./...
```

## Usage

```go
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

  client.On("task.dispatch", func(payload any) {
    task := payload.(aamp.ParsedMessage)
    if err := client.SendResult(aamp.SendResultOptions{
      To:        task.From,
      TaskID:    task.TaskID,
      Status:    "completed",
      Output:    "done",
      InReplyTo: task.MessageID,
    }); err != nil {
      log.Fatal(err)
    }
  })
  if err := client.Connect(); err != nil {
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
```

## Parse AAMP headers

```go
message, err := aamp.ParseAampHeaders(aamp.EmailMetadata{
  From:      "dispatcher@example.com",
  To:        "agent@example.com",
  MessageID: "<msg-1@example.com>",
  Subject:   "[AAMP Task] Review patch",
  BodyText:  "Please review the patch.",
  Headers: map[string]string{
    "X-AAMP-Intent":   "task.dispatch",
    "X-AAMP-TaskId":   "task-123",
    "X-AAMP-Priority": "high",
  },
})
```

## Run tests

```bash
cd packages/sdk-go
go test ./...
```
