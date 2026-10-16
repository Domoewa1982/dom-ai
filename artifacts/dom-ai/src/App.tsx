import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useSendChatMessage } from '@workspace/api-client-react';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { MarkdownMessage } from '@/components/markdown-message';
import { ArrowUp, AudioLines, ExternalLink, Mic, Moon, RotateCcw, Sparkles, Sun } from 'lucide-react';
import { Route, Switch, useLocation, Router as WouterRouter } from 'wouter';
import NotFound from '@/pages/not-found';

type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  time: number;
  sources?: ChatSource[];
};

type ChatSource = {
  title: string;
  url: string;
};

type SpeechResultEvent = {
  resultIndex: number;
  results: ArrayLike<ArrayLike<{ transcript: string }>>;
};

type SpeechRecognitionInstance = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechResultEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};

type SpeechRecognitionConstructor = new () => SpeechRecognitionInstance;
type SpeechWindow = Window & {
  SpeechRecognition?: SpeechRecognitionConstructor;
  webkitSpeechRecognition?: SpeechRecognitionConstructor;
};

const queryClient = new QueryClient();
const STORAGE_MESSAGES = 'dom-ai-chat-messages';
const STORAGE_THEME = 'dom-ai-theme';
const suggestions = [
  'Help me plan a calmer morning',
  'Give me a fresh perspective',
  'What can you help me with?',
];

function isChatSource(value: unknown): value is ChatSource {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('title' in value) ||
    !('url' in value) ||
    typeof value.title !== 'string' ||
    typeof value.url !== 'string'
  ) {
    return false;
  }
  try {
    const url = new URL(value.url);
    return (url.protocol === 'http:' || url.protocol === 'https:') && value.title.trim().length > 0;
  } catch {
    return false;
  }
}

function readSavedMessages(): ChatMessage[] {
  try {
    const stored = localStorage.getItem(STORAGE_MESSAGES);
    if (!stored) return [];
    const parsed: unknown = JSON.parse(stored);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is ChatMessage =>
      typeof item?.id === 'string' &&
      (item?.role === 'user' || item?.role === 'assistant') &&
      typeof item?.text === 'string' &&
      typeof item?.time === 'number' &&
      (item?.sources === undefined || (Array.isArray(item.sources) && item.sources.every(isChatSource))),
    );
  } catch {
    return [];
  }
}

function Home() {
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    try {
      return localStorage.getItem(STORAGE_THEME) === 'dark' ? 'dark' : 'light';
    } catch {
      return 'light';
    }
  });
  const [messages, setMessages] = useState<ChatMessage[]>(readSavedMessages);
  const [draft, setDraft] = useState('');
  const [thinking, setThinking] = useState(false);
  const [recording, setRecording] = useState(false);
  const [micNotice, setMicNotice] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const activeRequestRef = useRef(0);
  const sendChatMessage = useSendChatMessage();

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    try {
      localStorage.setItem(STORAGE_THEME, theme);
    } catch {
      // The chat remains usable when browser storage is unavailable.
    }
  }, [theme]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_MESSAGES, JSON.stringify(messages));
    } catch {
      // Local persistence is optional; keep the in-memory conversation.
    }
  }, [messages]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, thinking]);

  useEffect(() => () => {
    activeRequestRef.current += 1;
    recognitionRef.current?.stop();
  }, []);

  const addMessage = (role: ChatMessage['role'], text: string, sources: ChatSource[] = []) => ({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    role,
    text,
    time: Date.now(),
    ...(sources.length > 0 ? { sources } : {}),
  });

  const sendMessage = async (value = draft) => {
    const text = value.trim();
    if (!text || thinking) return;
    const requestId = activeRequestRef.current + 1;
    activeRequestRef.current = requestId;
    setMicNotice('');
    setDraft('');
    if (textareaRef.current) textareaRef.current.style.height = '42px';
    setMessages((current) => [...current, addMessage('user', text)]);
    setThinking(true);
    try {
      const history = messages.slice(-8).map((message) => ({
        role: message.role,
        content: message.text.slice(0, 1000),
      }));
      const result = await sendChatMessage.mutateAsync({
        data: { message: text, history },
      });
      if (requestId !== activeRequestRef.current) return;
      const sources = Array.isArray(result.sources) ? result.sources.filter(isChatSource).slice(0, 8) : [];
      setMessages((current) => [...current, addMessage('assistant', result.reply, sources)]);
    } catch (error) {
      if (requestId !== activeRequestRef.current) return;
      const apiError = error as { status?: unknown; data?: unknown };
      const status = Number(apiError.status) || 0;
      const serverMessage =
        typeof apiError.data === 'object' &&
        apiError.data !== null &&
        'error' in apiError.data &&
        typeof apiError.data.error === 'string'
          ? apiError.data.error
          : null;
      const errorMessage = serverMessage ?? (status === 429
        ? 'Dom AI is receiving too many messages right now. Please try again shortly.'
        : 'I couldn’t connect to Dom AI just now. Please try again.');
      setMessages((current) => [...current, addMessage('assistant', errorMessage)]);
    } finally {
      if (requestId === activeRequestRef.current) setThinking(false);
    }
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    sendMessage();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendMessage();
    }
  };

  const handleDraftChange = (value: string) => {
    setDraft(value);
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = '42px';
      textarea.style.height = `${Math.min(textarea.scrollHeight, 140)}px`;
    }
  };

  const toggleMicrophone = () => {
    if (recording) {
      recognitionRef.current?.stop();
      setRecording(false);
      setMicNotice('');
      return;
    }

    const speechWindow = window as SpeechWindow;
    const SpeechRecognition = speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setMicNotice('Voice input is not supported in this browser. You can type your message instead.');
      return;
    }

    try {
      const recognition = new SpeechRecognition();
      recognition.lang = navigator.language || 'en-US';
      recognition.continuous = false;
      recognition.interimResults = true;
      recognition.onresult = (event) => {
        let transcript = '';
        for (let index = event.resultIndex; index < event.results.length; index += 1) {
          transcript += event.results[index][0].transcript;
        }
        if (transcript) handleDraftChange(`${draft ? `${draft.trimEnd()} ` : ''}${transcript}`.trimStart());
      };
      recognition.onerror = (event) => {
        setRecording(false);
        setMicNotice(event.error === 'not-allowed'
          ? 'Microphone access was denied. You can type your message instead.'
          : 'Voice input ended. You can try again or type your message.');
      };
      recognition.onend = () => setRecording(false);
      recognitionRef.current = recognition;
      recognition.start();
      setRecording(true);
      setMicNotice('Listening…');
    } catch {
      setRecording(false);
      setMicNotice('Could not start voice input. You can type your message instead.');
    }
  };

  const startFreshChat = () => {
    activeRequestRef.current += 1;
    setMessages([]);
    setDraft('');
    setThinking(false);
    setMicNotice('');
    setRecording(false);
    recognitionRef.current?.stop();
    if (textareaRef.current) textareaRef.current.style.height = '42px';
  };

  const showWelcome = messages.length === 0;

  return (
    <div className="chat-shell" data-testid="screen-chat">
      <header className="topbar">
        <div className="brand-lockup" aria-label="Dom AI">
          <div className="brand-mark"><AudioLines size={19} strokeWidth={2.1} /></div>
          <div>
            <div className="brand-name">dom ai</div>
            <div className="brand-caption">A little space to think</div>
          </div>
        </div>
        <div className="top-actions">
          <button className="icon-button" type="button" onClick={startFreshChat} aria-label="Start a fresh chat" title="Start a fresh chat" data-testid="button-new-chat">
            <RotateCcw size={17} />
          </button>
          <button className="icon-button" type="button" onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')} aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`} title={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`} data-testid="button-toggle-theme">
            {theme === 'light' ? <Moon size={17} /> : <Sun size={17} />}
          </button>
        </div>
      </header>

      <main className="chat-main">
        <section className="message-list" aria-live="polite" ref={scrollRef} data-testid="conversation">
          {showWelcome ? (
            <div className="welcome">
              <div className="welcome-symbol"><Sparkles size={25} strokeWidth={1.7} /></div>
              <div className="eyebrow">Your own little corner</div>
              <h1>A good place<br />to <em>begin.</em></h1>
              <p className="welcome-copy">Bring a question, a half-formed thought, or just a moment. We’ll start wherever you are.</p>
              <div className="suggestions" aria-label="Try a suggested prompt">
                {suggestions.map((suggestion) => (
                  <button className="suggestion" type="button" key={suggestion} onClick={() => sendMessage(suggestion)} data-testid={`button-suggestion-${suggestions.indexOf(suggestion)}`}>
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="conversation">
              {messages.map((message) => (
                <article className={`message-row ${message.role}`} key={message.id} data-testid={`message-${message.role}-${message.id}`}>
                  {message.role === 'assistant' && <div className="assistant-avatar" aria-hidden="true"><Sparkles size={14} /></div>}
                  <div className="message-content">
                    <div className="message-meta">{message.role === 'user' ? 'You' : 'Dom'} · {new Date(message.time).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</div>
                    <div className="bubble" data-testid={`text-message-${message.id}`}>
                      {message.role === 'assistant'
                        ? <MarkdownMessage text={message.text} sources={message.sources ?? []} />
                        : message.text}
                    </div>
                    {message.sources && message.sources.length > 0 && (
                      <div className="message-sources" aria-label="Sources">
                        <div className="message-sources-label">Sources</div>
                        <ul className="message-sources-list">
                          {message.sources.map((source) => (
                            <li key={source.url}>
                              <a href={source.url} target="_blank" rel="noopener noreferrer" title={source.url}>
                                <span>{source.title}</span>
                                <ExternalLink size={12} aria-hidden="true" />
                              </a>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                </article>
              ))}
              {thinking && (
                <div className="message-row assistant" role="status" aria-label="Dom is thinking" data-testid="status-thinking">
                  <div className="assistant-avatar" aria-hidden="true"><Sparkles size={14} /></div>
                  <div className="message-content">
                    <div className="message-meta">Dom</div>
                    <div className="bubble"><div className="typing-dots"><span /><span /><span /></div></div>
                  </div>
                </div>
              )}
            </div>
          )}
        </section>
      </main>

      <div className="composer-wrap">
        <form className="composer" onSubmit={handleSubmit} aria-label="Send a message">
          <label className="sr-only" htmlFor="chat-message">Write a message</label>
          <textarea
            id="chat-message"
            ref={textareaRef}
            value={draft}
            onChange={(event) => handleDraftChange(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Write something…"
            rows={1}
            disabled={thinking}
            data-testid="input-message"
          />
          <div className="composer-tools">
            <button
              className={`mic-button${recording ? ' recording' : ''}`}
              type="button"
              onClick={toggleMicrophone}
              aria-label={recording ? 'Stop voice input' : 'Start voice input'}
              aria-pressed={recording}
              title={recording ? 'Stop voice input' : 'Voice input'}
              data-testid="button-microphone"
            >
              <Mic size={18} />
            </button>
            <button className="send-button" type="submit" disabled={!draft.trim() || thinking} aria-label="Send message" title="Send message" data-testid="button-send">
              <ArrowUp size={19} strokeWidth={2.3} />
            </button>
          </div>
        </form>
        <div className="composer-note" data-testid="status-composer-note">
          {recording
            ? <span className="recording-label">Listening… tap the microphone to stop</span>
            : micNotice || 'Groq free tier · messages sent to Groq'}
        </div>
      </div>
    </div>
  );
}

function Router() {
  return (
    <RoutedErrorBoundary>
      <Switch>
        <Route path="/" component={Home} />
        <Route component={NotFound} />
      </Switch>
    </RoutedErrorBoundary>
  );
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
