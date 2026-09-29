---
"emdash": patch
"@emdash-cms/admin": patch
---

Fixes image fields and media selection dropping the `caption` metadata. Captions entered in the media library now persist into selected image field values (`ImageValue`) so custom templates and queries can access `caption`.
