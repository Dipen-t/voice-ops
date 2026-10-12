# Hinglish document assistant

The user selected a clearly labeled fictional insurance FAQ for the first demo. The current local mode is `ASSISTANT_MODE=documents`. The interface is named Sahaayak, uses Roman Hinglish labels and greetings, supports continuous microphone conversation with interruption, and keeps cited document passages in a secondary panel. No real insurer, policy recommendation, payment, claim approval or customer document is involved.

UI copy and assistant replies now use Roman Hinglish, following the user preference. Exact source quotes retain their original language. Live microphone captions retain the script returned by transcription. The existing Hindi speech configuration remains; Roman Hinglish pronunciation needs manual listening verification.

## Documents and retrieval

`apps/web/public/sample-insurance-faq.md` is an authored CC0 fictional test document with twenty-one fictional teaching topics, including premium, waiting periods, claims, deductibles, co-payment, family floater, renewal, nomination and sub-limits. A restricted background worker indexes 21 section chunks in batches of at most eight into existing `knowledge_documents` and `knowledge_chunks` tables. The document queue is separate from the official runbook queue so its fixed demo job does not compete with runbook jobs. No new database tables, embedding download or runtime writer privileges were added.

Runtime sessions can select only the demo document. Both vector and lexical queries filter by that document ID before ranking; the assistant does not retrieve technical runbooks or incident telemetry. The existing 384-dimensional English MiniLM embedding model is retained: explicit Hindi/Hinglish insurance topics are normalized locally into English search queries; ambiguous questions and follow-ups use a bounded history-aware Groq translation request. Scoped local hybrid RAG supplies up to four passages to a Groq answer request. This translation path is implemented; a multilingual embedding model is not claimed.

Greetings, thanks and basic conversational phrases use fixed Roman Hinglish replies without LLM or retrieval calls. Covered policy replies require a citation, exact source quote and whole supported numeric values; thousands separators are normalized rather than checked as numeric substrings. The worked cost-sharing example contains explicitly fictional arithmetic figures, not actual policy amounts. Uncovered replies use a fixed acknowledgment of missing knowledge. These structural checks do not prove every semantic paraphrase correct. All displayed policy terms are explicitly fictional. Context is limited to three question/reply exchanges, with each question bounded to 500 and each reply to 1000 characters. Simple answers use two or three useful sentences; explanations may use four to six short sentences with supported examples, up to 110 words. Uploaded arbitrary PDFs or customer documents are not supported yet.

## Voice and playback

Sarvam transcription uses `saaras:v4`, auto language detection and mono PCM16 at 16 kHz. Hindi speech uses `bulbul:v4-flash`, `aparna_hi_customer`, `hi-IN`. Speech is transmitted in chunks after the answer passes grounding checks. Document mode has no spoken retrieval announcement; the investigator mode retains its recorded-evidence progress. Final model JSON is buffered for grounding checks before speech, rather than streamed as unchecked tokens.

The former 15-second scheduling cutoff caused normal accelerated TTS to interrupt itself. The replacement retains at most 4 MiB raw PCM and schedules roughly one second ahead in 250 ms segments. Playback begins on the first chunk and drains the remaining audio as time advances. Interruptions clear both scheduled and buffered audio; stale generations are ignored. Microphone mute sends silence, which still counts as input time. Existing per-process voice connection/character budgets and three-minute conversation limits remain.

The existing conservative budget remains four reserved model calls per rolling minute. Explicit topics reserve one call, and ambiguous questions reserve two; greetings reserve none. This permits up to four explicit-topic turns or two translated turns per minute, with mixed requests sharing the same budget. Unused reservations are conservatively retained. Free-plan throttling can still cause a wait. The interface retains one latest spoken follow-up while waiting for local capacity or cancellation, replacing it when the user asks another question. Provider failures are not retried automatically. No paid recharge is performed; live tests were authorized only for free signup credits.

## Setup and testing

Use the existing ignored `.env.model` with `ASSISTANT_MODE=documents`, `INVESTIGATOR_ENABLED=true`, API token, Groq/Sarvam keys and request flags enabled. Never put keys in chat. Run `npm run documents:setup` to build and index the fixed sample through the worker, then `npm run investigator:start` to serve the existing local container. The legacy service name remains an implementation detail. Open http://127.0.0.1:3002/, refresh, connect with the existing token and click Baatcheet shuru karein. The assistant greets automatically. Ask:

- Namaste
- Premium kya hota hai?
- Sample policy mein waiting period kitna hai?
- Claim ke liye kaun se documents chahiye?
- Cancellation par kitna refund milega? (The document intentionally omits this.)

Validation: 52 unit tests passed, including accelerated 40-second PCM playback with a short scheduling horizon, buffer limits, interruption, Hindi greetings, missing answers and rejected citations/numbers. Three document integration tests passed against the real local vector database: corpus scoping, authentication/capabilities, no-model greetings and retrieval of the waiting-period section. `npm run lint`, `npm run typecheck` and `npm run build` passed.

An explicit live synthetic Hindi voice test passed through Sarvam STT, Groq query translation, scoped vector retrieval, a cited Hindi answer and Sarvam TTS. The recognized question was “सैंपल पॉलिसी में वेटिंग पीरियड कितना है?”; the answer cited the exact fictional 30-day illness waiting-period sentence. The test made zero incident tool calls, received 29 partial captions, progress audio and report audio. Report: `eval/reports/hindi-document-voice-smoke.json`. It deliberately disconnects after the first report audio chunk. It does not establish a complete audible browser reply or microphone acceptance.

Browser automation is unavailable on this host; actual microphone use, full audible reply, echo suppression and repeated spoken interruptions still need manual acceptance. No real financial guidance or typical latency guarantee is claimed.

Sarvam voice selection follows the [official v4 Flash voice guide](https://docs.sarvam.ai/api/api-guides-tutorials/text-to-speech/best-practice-guide-for-bulbul-v-4-flash).

## Current conversation update validation

`npm run lint`, `npm run typecheck`, `npm run build`, targeted lint after repairs, root `tsc --noEmit` and `tsc -p tsconfig.build.json` passed. 58 unit tests and five document integration tests passed. The expanded FAQ indexed as 21 chunks using the existing restricted worker. Initial indexing exceeded the eight-input embedding limit; batching fixed this without raising the embedding limit. The prior index is not replaced if a batch fails.

The initial detailed live voice test failed because the model invented numeric examples; grounding rejected them. An explicitly fictional sourced arithmetic example and whole-number validation repaired this. The subsequent complete synthetic voice test passed through STT, local topic normalization, scoped vector RAG, Groq and all TTS audio through `audio_end`, with zero progress audio. Report: `eval/reports/hinglish-insurance-detailed-voice-smoke.json`. This confirms complete generated audio transport, not actual browser listening or microphone quality. A further prompt refinement prohibits unsupported claims that cost-sharing mechanisms cap member spending.

Command: `node --env-file=.env.model --import tsx scripts/voice-smoke.ts --gateway --documents --detailed --complete-answer`. Only the previously authorized free provider credits were used. No recharge occurred. Free-plan rate limits still apply.
The final local configuration uses Groq `openai/gpt-oss-120b`. Groq lists this model in its [free-plan limits](https://console.groq.com/docs/rate-limits) and [strict structured-output support](https://console.groq.com/docs/structured-outputs). The smaller 20B model dropped policy qualifications in reviewed synthetic answers; the larger model was selected for the demo. The final complete voice report records the actual 120B model, a five-sentence Roman Hinglish answer, zero progress audio and receipt of all answer audio. This is a single synthetic smoke test, not a general semantic-accuracy evaluation or a browser latency guarantee.