## Feature Flags

Use [OpenFeature](https://openfeature.dev/) as the feature flag abstraction layer. OpenFeature is vendor-agnostic and supports all major providers, so the application code never couples directly to a specific service.

For the backing provider, use [LaunchDarkly](https://launchdarkly.com/). If the provider needs to change later, only the OpenFeature provider configuration changes — no application code modifications required.

### Flag keys

| Key | Type | Default | Used by | Purpose |
|-----|------|---------|---------|---------|
| `stt.sarvam.enabled` | boolean | `true` | `createWhatsappAudioMedia` | Enable/disable Sarvam STT provider |
| `stt.azure.enabled` | boolean | `true` | `createWhatsappAudioMedia` | Enable/disable Azure STT provider |
| `stt.reverie.enabled` | boolean | `true` | `createWhatsappAudioMedia` | Enable/disable Reverie STT provider |
