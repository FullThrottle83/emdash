---
"emdash": patch
---

Reduces the database queries that site search and search suggestions run per request. Each isolate now caches collection search settings, so a repeat search runs only the full-text query. Search setting changes apply immediately on the isolate that made them; other isolates pick them up within 60 seconds.
