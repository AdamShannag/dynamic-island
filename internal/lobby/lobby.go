package lobby

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync"
)

const DefaultPort = 54372

var (
	ErrClosed   = errors.New("lobby: closed")
	ErrRejected = errors.New("lobby: rejected")
)

type Invite struct {
	LobbyID, Kind, HostID, HostName, HostAddr string
}

type Response struct {
	LobbyID, PeerID, PeerName string
	Accept                    bool
}

type Start struct {
	LobbyID string
	Payload json.RawMessage
}

type Progress struct {
	LobbyID, PeerID string
	Payload         json.RawMessage
}

type Callbacks struct {
	OnInvite   func(Invite) error
	OnRespond  func(Response) error
	OnStart    func(Start) error
	OnProgress func(Progress) error
}

type Server struct {
	httpSrv *http.Server
	cb      Callbacks

	mu   sync.Mutex
	subs map[string][]chan json.RawMessage
}

func NewServer(port int, cb Callbacks) *Server {
	s := &Server{
		cb:   cb,
		subs: make(map[string][]chan json.RawMessage),
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/invite", s.handleInvite)
	mux.HandleFunc("/respond", s.handleRespond)
	mux.HandleFunc("/start", s.handleStart)
	mux.HandleFunc("/progress", s.handleProgress)
	mux.HandleFunc("/events", s.handleEvents)
	s.httpSrv = &http.Server{
		Addr:    fmt.Sprintf(":%d", port),
		Handler: mux,
	}
	return s
}

func (s *Server) ListenAndServe() error {
	return s.httpSrv.ListenAndServe()
}

func (s *Server) Close() error {
	return s.httpSrv.Close()
}

func decodeBody[T any](w http.ResponseWriter, r *http.Request) (T, bool) {
	var v T
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10)).Decode(&v); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return v, false
	}
	return v, true
}

func (s *Server) handleInvite(w http.ResponseWriter, r *http.Request) {
	v, ok := decodeBody[Invite](w, r)
	if ok {
		reply(w, call(s.cb.OnInvite, v))
	}
}

func (s *Server) handleRespond(w http.ResponseWriter, r *http.Request) {
	v, ok := decodeBody[Response](w, r)
	if ok {
		reply(w, call(s.cb.OnRespond, v))
	}
}

func (s *Server) handleStart(w http.ResponseWriter, r *http.Request) {
	v, ok := decodeBody[Start](w, r)
	if ok {
		reply(w, call(s.cb.OnStart, v))
	}
}

func (s *Server) handleProgress(w http.ResponseWriter, r *http.Request) {
	v, ok := decodeBody[Progress](w, r)
	if ok {
		reply(w, call(s.cb.OnProgress, v))
	}
}

func call[T any](fn func(T) error, v T) error {
	if fn == nil {
		return nil
	}
	return fn(v)
}

func reply(w http.ResponseWriter, err error) {
	switch {
	case err == nil:
	case errors.Is(err, ErrClosed):
		http.Error(w, "lobby closed", http.StatusConflict)
	default:
		http.Error(w, "bad request", http.StatusBadRequest)
	}
}

func (s *Server) handleEvents(w http.ResponseWriter, r *http.Request) {
	lobbyID := r.URL.Query().Get("lobby")
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}

	ch := make(chan json.RawMessage, 8)
	if !s.addSub(lobbyID, ch) {
		http.Error(w, "no such lobby", http.StatusNotFound)
		return
	}
	defer s.removeSub(lobbyID, ch)

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	ctx := r.Context()
	for {
		select {
		case <-ctx.Done():
			return
		case payload, open := <-ch:
			if !open {
				return
			}
			fmt.Fprint(w, sseLine(payload))
			flusher.Flush()
		}
	}
}

func sseLine(payload json.RawMessage) string {
	var buf bytes.Buffer
	if err := json.Compact(&buf, payload); err == nil {
		payload = buf.Bytes()
	}
	return fmt.Sprintf("data: %s\n\n", payload)
}

func (s *Server) OpenLobby(lobbyID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.subs[lobbyID]; !ok {
		s.subs[lobbyID] = nil
	}
}

func (s *Server) addSub(lobbyID string, ch chan json.RawMessage) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	chans, open := s.subs[lobbyID]
	if !open {
		return false
	}
	s.subs[lobbyID] = append(chans, ch)
	return true
}

func (s *Server) removeSub(lobbyID string, ch chan json.RawMessage) {
	s.mu.Lock()
	defer s.mu.Unlock()
	chans, open := s.subs[lobbyID]
	if !open {
		return
	}
	for i, c := range chans {
		if c == ch {
			s.subs[lobbyID] = append(chans[:i], chans[i+1:]...)
			return
		}
	}
}

func (s *Server) Broadcast(lobbyID string, payload json.RawMessage) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, ch := range s.subs[lobbyID] {
		select {
		case ch <- payload:
		default:
		}
	}
}

func (s *Server) EndLobby(lobbyID string, payload json.RawMessage) {
	s.mu.Lock()
	defer s.mu.Unlock()
	chans := s.subs[lobbyID]
	delete(s.subs, lobbyID)
	for _, ch := range chans {
		select {
		case ch <- payload:
		default:
		}
		close(ch)
	}
}

func post(addr, path string, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	resp, err := http.Post(fmt.Sprintf("http://%s%s", addr, path), "application/json", bytes.NewReader(b))
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	switch resp.StatusCode {
	case http.StatusOK:
		return nil
	case http.StatusConflict:
		return fmt.Errorf("lobby: %s: %w", path, ErrClosed)
	default:
		return fmt.Errorf("lobby: %s returned status %d", path, resp.StatusCode)
	}
}

func SendInvite(addr string, inv Invite) error {
	return post(addr, "/invite", inv)
}

func SendRespond(addr string, r Response) error {
	return post(addr, "/respond", r)
}

func SendStart(addr string, s Start) error {
	return post(addr, "/start", s)
}

func SendProgress(addr string, p Progress) error {
	return post(addr, "/progress", p)
}

func Subscribe(addr, lobbyID string, onEvent func(json.RawMessage), onClosed func(error)) (cancel func()) {
	ctx, cancelFn := context.WithCancel(context.Background())
	go func() {
		err := subscribeLoop(ctx, addr, lobbyID, onEvent)
		if ctx.Err() == nil {
			onClosed(err)
		}
	}()
	return cancelFn
}

func subscribeLoop(ctx context.Context, addr, lobbyID string, onEvent func(json.RawMessage)) error {
	u := fmt.Sprintf("http://%s/events?lobby=%s", addr, url.QueryEscape(lobbyID))
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return err
	}
	resp, err := (&http.Client{}).Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("lobby: /events returned status %d", resp.StatusCode)
	}

	scanner := bufio.NewScanner(resp.Body)
	for scanner.Scan() {
		data, ok := strings.CutPrefix(scanner.Text(), "data: ")
		if !ok {
			continue
		}
		onEvent(json.RawMessage(data))
	}
	return scanner.Err()
}
