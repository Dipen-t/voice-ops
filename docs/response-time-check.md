# Local voice response-time check

Three complete synthetic Hindi voice turns were tested on the running document demo with Groq `openai/gpt-oss-120b` and Sarvam speech. Each row is one sample, not a typical latency, average or percentile benchmark. No microphone or audible browser playback was tested. Only previously authorized free provider credits were used.

| Scenario | API request to validated reply | End of input PCM to first audio received | Server VAD end to first audio | Retrieval | Model generation and validation |
|---|---:|---:|---:|---:|---:|
| “Achha theek hai, theek hai, samajh gaya” | 13 ms | 2010 ms | 690 ms | Not invoked | Not invoked |
| Waiting-period question | 1410 ms | 3192 ms | 1877 ms | 626 ms, first query after restart | 775 ms |
| Detailed deductible/co-payment question | 1322 ms | 3140 ms | 1866 ms | 15 ms, warm | 1296 ms |

The input-end metric starts when the test client sends the last chunk of its generated utterance; it includes silence detection, transcription finalization, API handling and synthesis startup. It does not establish exactly when a real person stops speaking. The server VAD metric starts later, when Sarvam reports `vad.speech_end`, and excludes the preceding pause detection. Receiving audio does not include browser decoding, playback scheduling or speaker delay.

The last-input-to-request-start interval was 1732, 1558 and 1470 ms respectively. Once the validated reply reached the test client, first answer audio took another 265, 224 and 348 ms. The first retrieval includes starting the local embedding worker; subsequent retrieval is warm. All three streams reached `audio_end` with no progress announcement. The model budget and free-plan/provider limits still apply.

## Acknowledgments

Hindi and Roman Hinglish acknowledgment sequences are matched locally by a shared browser/server function. Examples include `ठीक है`, `समझ गया`, `समझ गई`, `अच्छा ठीक है, ठीक है, समझ गया।`, `Haan ji` and `Okay, got it`. They receive a brief Hinglish response and do not invoke embeddings, RAG or Groq. They bypass a model cooldown and preserve the preceding substantive conversation context; the voice session continues. Normal session limits still apply.

Matching requires the entire utterance to be acknowledgment phrases. `Theek hai, premium kitna hai?`, `Samajh gaya, claim kaise karoon?` and `Theek hai lekin samajh nahi aaya` remain substantive questions or follow-ups. The existing API labels these local small-talk replies as `kind: greeting` for compatibility.

## Reproduce and validation

`npm run lint`, `npm run typecheck`, `npm run build`, 59 unit tests and five document integration tests passed. An initial integration assertion retained a mutable spy argument; its expectation was corrected to include the completed substantive turn, and all five integration tests then passed. No extra provider calls were needed for those tests.

Commands for the three live samples:

```powershell
node --env-file=.env.model --import tsx scripts/voice-smoke.ts --gateway --documents --acknowledgement --complete-answer
node --env-file=.env.model --import tsx scripts/voice-smoke.ts --gateway --documents --complete-answer
node --env-file=.env.model --import tsx scripts/voice-smoke.ts --gateway --documents --detailed --complete-answer
```

Combined report: `eval/reports/hinglish-response-time-check.json`. Source reports: `hinglish-acknowledgement-voice-smoke.json`, `hindi-document-voice-smoke.json`, and `hinglish-insurance-detailed-voice-smoke.json` in `eval/reports`.

Further tuning should focus on speech-end/final-transcript delay and model generation. Reducing the end-of-speech pause requires testing natural pauses so questions are not cut short. General answer accuracy and actual microphone/echo/interruption behavior still need separate evaluation.

## Speech-end tuning, 2026-10-10

The document assistant now explicitly sets Sarvam's `silence_duration_ms=300` instead of the documented default 500 ms, retaining `min_speech_duration_ms=250` and `stream_type=fast`. This changes the silence threshold, not a promise of a 300 ms spoken answer. The incident prototype retains its previous settings. No dependencies, routes or database tables were added. [Sarvam realtime parameters](https://docs.sarvam.ai/api/api-guides-tutorials/speech-to-text/realtime-streaming).

Each row below is one new synthetic voice sample. Earlier baseline reports were preserved. Different provider timing and generated audio lengths mean these are observations, not a controlled estimate of the tuning's effect.

| Scenario | API request to reply | Last input PCM to first audio | Server VAD end to first audio | Retrieval | Model generation and validation |
|---|---:|---:|---:|---:|---:|
| Acknowledgment | 27 ms | 1224 ms | 668 ms | Not invoked | Not invoked |
| Waiting-period question, first retrieval after restart | 1556 ms | 2669 ms | 2170 ms | 765 ms | 775 ms |
| Same question with an inserted 200 ms internal pause, warm retrieval | 1031 ms | 2234 ms | 1686 ms | 15 ms | 1002 ms |

The inserted pause was synthetic silence halfway through the generated PCM utterance. The test rejects finalization before the last input chunk; it received the full question, including the waiting-period request. This does not establish tolerance of longer pauses, hesitations, noise or real microphone speech. With a shorter threshold, pauses around 300 ms or longer may end a turn prematurely. All three replies completed their audio stream and emitted no retrieval announcement. The acknowledgment used no retrieval or model. End-to-end 300 ms was not achieved.

```powershell
node --env-file=.env.model --import tsx scripts/voice-smoke.ts --gateway --documents --acknowledgement --complete-answer --tuned
node --env-file=.env.model --import tsx scripts/voice-smoke.ts --gateway --documents --complete-answer --tuned
node --env-file=.env.model --import tsx scripts/voice-smoke.ts --gateway --documents --complete-answer --tuned --pause-test
```

Reports: `eval/reports/hinglish-acknowledgement-voice-smoke-tuned.json`, `eval/reports/hindi-document-voice-smoke-tuned.json`, and `eval/reports/hindi-document-voice-smoke-tuned-pause.json`. `--tuned` labels the measured deployment and preserves baseline files; it does not change server configuration. `--pause-test` is restricted to the complete simple document gateway test.

Validation for this change: `npm run lint`, `npm run typecheck`, `npm run build`, `npm test` (59 tests) and `npm run test:documents` (5 tests) passed. The first sandboxed unit test run failed with inaccessible Vitest temporary files in six suites; rerunning outside that sandbox passed all 59 tests. The rebuilt local Docker demo is healthy. No browser microphone or audible playback test was performed.
