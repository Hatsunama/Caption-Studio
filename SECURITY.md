# Security policy

## Supported releases

Security fixes are applied to the latest published Caption Studio release. Users should update to the newest APK or Google Play release before reporting an issue that may already be resolved.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability or include private media, transcripts, signing material, or device logs in a public report. Use GitHub's private vulnerability-reporting form:

https://github.com/Hatsunama/Caption-Studio/security/advisories/new

Include the affected app version, Android version, device model, reproduction steps, impact, and the smallest sanitized sample needed to reproduce the problem. You should receive an initial response within seven days.

## Security boundaries

Caption Studio processes selected media and transcription models locally. Android document-provider URIs, imported fonts, video/audio containers, subtitle text, and downloaded model files are untrusted inputs. The app does not treat code shrinking, obfuscation, or a self-signed upload certificate as a security boundary.
