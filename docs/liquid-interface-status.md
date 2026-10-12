# Liquid companion interface

The document demo now uses a neutral light canvas, a focused voice card, a subtle metallic fluid ring, a separate answer/caption panel and aligned quick questions. It replaces the earlier dark, glowing design following user feedback. Labels remain Roman Hinglish. Existing listening, speaking, thinking, connecting and muted states drive the animation; bars are a state indicator, not a microphone-level measurement. Reduced-motion users receive a static visual.

Design research: Linear's calmer interface guidance informed the quieter supporting controls and clear hierarchy: https://linear.app/now/behind-the-latest-design-refresh. ElevenLabs UI and Apple's materials guidance were also searched; their full pages could not be fetched through the web tool (403 and JavaScript-only respectively). No component library or provider was added.

This phase changes no provider configuration, routes or database tables. Existing Groq free-plan and authorized Sarvam signup-credit usage remain in place.

Validation: npm run lint, npm run typecheck, npm run build and npm test passed (59 tests). Desktop 1280x900 and phone 390x844 layouts were inspected. Existing local-token login and the no-model greeting were verified in the browser. The typed-question disclosure was opened. Voice microphone, audible playback and interruption behavior were not retested in this visual phase. The rebuilt local Docker demo is healthy.

Screenshots: liquid-assistant-desktop.jpg and liquid-assistant-mobile.jpg in docs/screenshots reflect the revised design.
