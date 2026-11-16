package lobby

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf8"
)

const (
	DefaultPort = 54372
	callTimeout = 4 * time.Second

	maxIDLen       = 64
	maxKindLen     = 32
	maxNameLen     = 100
	maxSubscribers = 32
)

var (
	heartbeatEvery = newInterval(5 * time.Second)
	silenceLimit   = newInterval(15 * time.Second)
	errSilent      = errors.New("lobby: host went silent")

	client       = &http.Client{Timeout: callTimeout}
	streamClient = &http.Client{Transport: &http.Transport{
		DialContext:           (&net.Dialer{Timeout: callTimeout}).DialContext,
		ResponseHeaderTimeout: callTimeout,
	}}
)

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
	RemoteIP                  string `json:"-"`
}

type Start struct {
	LobbyID  string
	Payload  json.RawMessage
	RemoteIP string `json:"-"`
}

type Progress struct {
	LobbyID, PeerID string
	Payload         json.RawMessage
	RemoteIP        string `json:"-"`
}

type interval struct{ ns atomic.Int64 }

func newInterval(d time.Duration) *interval {
	i := &interval{}
	i.set(d)
	return i
}

func (i *interval) get() time.Duration  { return time.Duration(i.ns.Load()) }
func (i *interval) set(d time.Duration) { i.ns.Store(int64(d)) }

func (v Invite) valid() bool {
	return id(v.LobbyID) && text(v.Kind, maxKindLen) && v.Kind != "" && id(v.HostID) && text(v.HostName, maxNameLen)
}

func (v Response) valid() bool {
	return id(v.LobbyID) && id(v.PeerID) && text(v.PeerName, maxNameLen)
}

func (v Start) valid() bool { return id(v.LobbyID) }

func (v Progress) valid() bool { return id(v.LobbyID) && id(v.PeerID) }

func id(s string) bool { return s != "" && text(s, maxIDLen) }

func text(s string, max int) bool { return len(s) <= max && utf8.ValidString(s) }

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
		Addr:              fmt.Sprintf(":%d", port),
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}
	return s
}

func (s *Server) Listen() error {
	ln, err := net.Listen("tcp", s.httpSrv.Addr)
	if err != nil {
		return fmt.Errorf("lobby: listen on %s: %w", s.httpSrv.Addr, err)
	}
	go func() { _ = s.httpSrv.Serve(ln) }()
	return nil
}

func (s *Server) Close() error {
	return s.httpSrv.Close()
}

func decodeBody[T interface{ valid() bool }](w http.ResponseWriter, r *http.Request) (T, bool) {
	var v T
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10)).Decode(&v); err != nil || !v.valid() {
		http.Error(w, "bad request", http.StatusBadRequest)
		return v, false
	}
	return v, true
}

func (s *Server) handleInvite(w http.ResponseWriter, r *http.Request) {
	v, ok := decodeBody[Invite](w, r)
	if !ok {
		return
	}
	addr, err := fromRemote(r, v.HostAddr)
	if err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	v.HostAddr = addr
	reply(w, call(s.cb.OnInvite, v))
}

func (s *Server) handleRespond(w http.ResponseWriter, r *http.Request) {
	v, ok := decodeBody[Response](w, r)
	if ok {
		v.RemoteIP = remoteIP(r)
		reply(w, call(s.cb.OnRespond, v))
	}
}

func (s *Server) handleStart(w http.ResponseWriter, r *http.Request) {
	v, ok := decodeBody[Start](w, r)
	if ok {
		v.RemoteIP = remoteIP(r)
		reply(w, call(s.cb.OnStart, v))
	}
}

func (s *Server) handleProgress(w http.ResponseWriter, r *http.Request) {
	v, ok := decodeBody[Progress](w, r)
	if ok {
		v.RemoteIP = remoteIP(r)
		reply(w, call(s.cb.OnProgress, v))
	}
}

func remoteIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func fromRemote(r *http.Request, claimed string) (string, error) {
	_, port, err := net.SplitHostPort(claimed)
	if err != nil {
		return "", err
	}
	if n, err := strconv.Atoi(port); err != nil || n <= 0 || n > 65535 {
		return "", fmt.Errorf("lobby: bad port %q", port)
	}
	return net.JoinHostPort(remoteIP(r), port), nil
}

func WithHost(addr, ip string) string {
	_, port, err := net.SplitHostPort(addr)
	if err != nil || ip == "" {
		return addr
	}
	return net.JoinHostPort(ip, port)
}

func SameHost(addr, ip string) bool {
	host, _, err := net.SplitHostPort(addr)
	return err == nil && host == ip
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
	if !id(lobbyID) {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}

	ch := make(chan json.RawMessage, 8)
	if status := s.addSub(lobbyID, ch); status != http.StatusOK {
		http.Error(w, http.StatusText(status), status)
		return
	}
	defer s.removeSub(lobbyID, ch)

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	heartbeat := time.NewTicker(heartbeatEvery.get())
	defer heartbeat.Stop()
	ctx := r.Context()
	for {
		select {
		case <-ctx.Done():
			return
		case <-heartbeat.C:
			fmt.Fprint(w, ": ping\n\n")
			flusher.Flush()
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

func (s *Server) addSub(lobbyID string, ch chan json.RawMessage) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	chans, open := s.subs[lobbyID]
	switch {
	case !open:
		return http.StatusNotFound
	case len(chans) >= maxSubscribers:
		return http.StatusServiceUnavailable
	}
	s.subs[lobbyID] = append(chans, ch)
	return http.StatusOK
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
	resp, err := client.Post(fmt.Sprintf("http://%s%s", addr, path), "application/json", bytes.NewReader(b))
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

func subscribeLoop(parent context.Context, addr, lobbyID string, onEvent func(json.RawMessage)) error {
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	u := fmt.Sprintf("http://%s/events?lobby=%s", addr, url.QueryEscape(lobbyID))
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return err
	}
	resp, err := streamClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("lobby: /events returned status %d", resp.StatusCode)
	}

	limit := silenceLimit.get()
	var silent atomic.Bool
	watchdog := time.AfterFunc(limit, func() {
		silent.Store(true)
		cancel()
	})
	defer watchdog.Stop()

	scanner := bufio.NewScanner(resp.Body)
	for scanner.Scan() {
		watchdog.Reset(limit)
		data, ok := strings.CutPrefix(scanner.Text(), "data: ")
		if !ok {
			continue
		}
		onEvent(json.RawMessage(data))
	}
	if silent.Load() {
		return errSilent
	}
	return scanner.Err()
}
