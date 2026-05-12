package aamp

import "time"

type Config struct {
	Email              string
	MailboxToken       string
	BaseURL            string
	HTTPSendBaseURL    string
	SMTPHost           string
	SMTPPort           int
	SMTPPassword       string
	ReconnectInterval  time.Duration
	RejectUnauthorized bool
}

type MailboxIdentityConfig struct {
	Email              string
	SMTPPassword       string
	BaseURL            string
	SMTPPort           int
	ReconnectInterval  time.Duration
	RejectUnauthorized bool
}

type RegisterMailboxOptions struct {
	AAMPHost    string `json:"aampHost"`
	Slug        string `json:"slug"`
	Description string `json:"description,omitempty"`
}

type RegisteredMailboxIdentity struct {
	Email        string `json:"email"`
	MailboxToken string `json:"mailboxToken"`
	SMTPPassword string `json:"smtpPassword"`
	BaseURL      string `json:"baseUrl"`
}

type DiscoveryDocument struct {
	Protocol     string                 `json:"protocol"`
	Version      string                 `json:"version"`
	Intents      []string               `json:"intents,omitempty"`
	API          *DiscoveryAPI          `json:"api,omitempty"`
	Endpoints    map[string]string      `json:"endpoints,omitempty"`
	Capabilities *DiscoveryCapabilities `json:"capabilities,omitempty"`
}

type DiscoveryAPI struct {
	URL     string   `json:"url,omitempty"`
	Actions []string `json:"actions,omitempty"`
}

type DiscoveryCapabilities struct {
	Stream *StreamCapability `json:"stream,omitempty"`
}

type StreamCapability struct {
	Transport            string `json:"transport"`
	CreateAction         string `json:"createAction,omitempty"`
	AppendAction         string `json:"appendAction,omitempty"`
	CloseAction          string `json:"closeAction,omitempty"`
	GetAction            string `json:"getAction,omitempty"`
	SubscribeURLTemplate string `json:"subscribeUrlTemplate,omitempty"`
}

type AgentDirectoryEntry struct {
	Email   string  `json:"email"`
	Summary *string `json:"summary"`
}

type AgentDirectorySearchEntry struct {
	Email   string  `json:"email"`
	Summary *string `json:"summary"`
	Score   float64 `json:"score"`
}

type AgentDirectoryProfile struct {
	Email    string  `json:"email"`
	Summary  *string `json:"summary"`
	CardText *string `json:"cardText"`
}

type Attachment struct {
	Filename    string
	ContentType string
	Content     []byte
}

type StructuredResultField struct {
	FieldKey            string   `json:"fieldKey"`
	FieldTypeKey        string   `json:"fieldTypeKey"`
	Value               any      `json:"value,omitempty"`
	FieldAlias          string   `json:"fieldAlias,omitempty"`
	Index               string   `json:"index,omitempty"`
	AttachmentFilenames []string `json:"attachmentFilenames,omitempty"`
}

type SendTaskOptions struct {
	To              string
	TaskID          string
	Title           string
	BodyText        string
	Priority        string
	ExpiresAt       string
	DispatchContext map[string]string
	ParentTaskID    string
	Attachments     []Attachment
}

type SendCancelOptions struct {
	To        string
	TaskID    string
	BodyText  string
	InReplyTo string
}

type SendResultOptions struct {
	To               string
	TaskID           string
	Status           string
	Output           string
	ErrorMsg         string
	StructuredResult []StructuredResultField
	InReplyTo        string
	Attachments      []Attachment
}

type SendHelpOptions struct {
	To               string
	TaskID           string
	Question         string
	BlockedReason    string
	SuggestedOptions []string
	InReplyTo        string
	Attachments      []Attachment
}

type SendCardQueryOptions struct {
	To        string
	TaskID    string
	BodyText  string
	InReplyTo string
}

type SendCardResponseOptions struct {
	To        string
	TaskID    string
	Summary   string
	BodyText  string
	InReplyTo string
}

type CreateStreamOptions struct {
	TaskID    string `json:"taskId"`
	PeerEmail string `json:"peerEmail"`
}

type CreateStreamResult struct {
	StreamID   string `json:"streamId"`
	TaskID     string `json:"taskId"`
	Status     string `json:"status"`
	OwnerEmail string `json:"ownerEmail"`
	PeerEmail  string `json:"peerEmail"`
	CreatedAt  string `json:"createdAt"`
	OpenedAt   string `json:"openedAt,omitempty"`
	ClosedAt   string `json:"closedAt,omitempty"`
}

type StreamEvent struct {
	ID        string         `json:"id,omitempty"`
	StreamID  string         `json:"streamId"`
	TaskID    string         `json:"taskId"`
	Seq       int            `json:"seq"`
	Timestamp string         `json:"timestamp"`
	Type      string         `json:"type"`
	Payload   map[string]any `json:"payload"`
}

type AppendStreamEventOptions struct {
	StreamID string         `json:"streamId"`
	Type     string         `json:"type"`
	Payload  map[string]any `json:"payload"`
}

type CloseStreamOptions struct {
	StreamID string         `json:"streamId"`
	Payload  map[string]any `json:"payload,omitempty"`
}

type TaskStreamState struct {
	StreamID    string       `json:"streamId"`
	TaskID      string       `json:"taskId"`
	Status      string       `json:"status"`
	OwnerEmail  string       `json:"ownerEmail"`
	PeerEmail   string       `json:"peerEmail"`
	CreatedAt   string       `json:"createdAt"`
	OpenedAt    string       `json:"openedAt,omitempty"`
	ClosedAt    string       `json:"closedAt,omitempty"`
	LatestEvent *StreamEvent `json:"latestEvent,omitempty"`
}

type DirectoryListOptions struct {
	Scope       string
	IncludeSelf *bool
	Limit       int
}

type DirectorySearchOptions struct {
	Query string
	Scope string
	Limit int
}

type UpdateDirectoryProfileOptions struct {
	Summary  *string `json:"summary,omitempty"`
	CardText *string `json:"cardText,omitempty"`
}

type EmailMetadata struct {
	From      string
	To        string
	MessageID string
	Subject   string
	Headers   map[string]string
	BodyText  string
}

type ParsedMessage struct {
	ProtocolVersion  string
	Intent           string
	TaskID           string
	Title            string
	Priority         string
	ExpiresAt        string
	DispatchContext  map[string]string
	ParentTaskID     string
	From             string
	To               string
	MessageID        string
	Subject          string
	BodyText         string
	InReplyTo        string
	References       []string
	Status           string
	Output           string
	ErrorMsg         string
	StructuredResult any
	Question         string
	BlockedReason    string
	SuggestedOptions []string
	StreamID         string
	Summary          string
	Attachments      []ReceivedAttachment
}

type ReceivedAttachment struct {
	Filename    string
	ContentType string
	Size        int
	BlobID      string
}
