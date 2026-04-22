package aamp

import "sync"

type EventHandler func(any)

type Emitter struct {
	mu        sync.RWMutex
	listeners map[string][]EventHandler
}

func NewEmitter() *Emitter {
	return &Emitter{listeners: map[string][]EventHandler{}}
}

func (e *Emitter) On(event string, handler EventHandler) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.listeners[event] = append(e.listeners[event], handler)
}

func (e *Emitter) Emit(event string, payload any) {
	e.mu.RLock()
	handlers := append([]EventHandler(nil), e.listeners[event]...)
	e.mu.RUnlock()
	for _, handler := range handlers {
		handler(payload)
	}
}
