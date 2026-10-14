# Image Parts, Transcript Archives, and Token Budgeting

This document records how `ai-agent-local-memory` handles screenshots and image
attachments in OpenCode sessions.

## Why this matters

OpenCode stores pasted screenshots as session `file` parts. For screenshots the payload is
usually embedded directly in the part as a data URI:

```text
part.type = "file"
part.url  = "data:image/png;base64,..."
```

That base64 payload can be very large. A single screenshot can be several megabytes once
encoded. If a context compressor ignores these parts, it underestimates the real prompt
size and may believe the session is safely under budget while the upstream model request is
actually too large.

## Runtime context handling

The context-compression path treats image/file parts as billable input even though they are
not normal text.

Implementation:

- `packages/core/src/context-compressor.ts`
- `partBillableText()`
- `IMAGE_TOKEN_PLACEHOLDER = "x".repeat(5400)`

For any part matching one of the following:

```ts
part.type === "file"
part.type === "image"
part.url starts with "data:image/"
```

`partBillableText()` returns a fixed placeholder string. This intentionally charges image
parts approximately 1,500 tokens in the tail-budget scan. The exact image-token cost is
provider-specific, but the important invariant is: **screenshots are no longer counted as
zero**.

This prevents the same class of bug previously seen with tool outputs: a non-text payload
being counted as ~0 tokens, causing the compressor to keep too much raw history and later
hit an upstream "input too long" failure.

## Transcript archive handling

The transcript writer is a durable human-readable archive under:

```text
~/.local/share/ai-agent-local-memory/transcripts/<session-id>.md
```

Before this change, the writer handled only:

- `text`
- `reasoning`
- `tool`

Screenshot/file parts fell through the `default` branch and were silently omitted from the
Markdown archive.

Now image file parts are extracted into sidecar image files next to the transcript:

```text
~/.local/share/ai-agent-local-memory/transcripts/<session-id>.md
~/.local/share/ai-agent-local-memory/transcripts/<session-id>-assets/<sha1>.png
```

The Markdown transcript references the extracted file using standard Markdown image syntax:

```md
![image](<session-id>-assets/<sha1>.png)
```

The path is relative to the transcript file. This is deliberate: relative paths work in
normal Markdown readers when the `.md` file and the assets directory are copied together.

## Why images are sidecar files, not inline base64

The transcript is meant to stay readable and grep-friendly. Inlining base64 into Markdown
would make a single screenshot expand the `.md` by hundreds of kilobytes or megabytes.

Instead:

- the binary payload is decoded into a real image file;
- the Markdown stays readable;
- the image displays in Markdown viewers;
- repeated exports are idempotent;
- identical images deduplicate by content hash.

## Memory graph behavior

Images are **not** inserted into the semantic memory graph.

The memory graph stores text-like knowledge that can be searched, linked, embedded, and
recalled. Raw image bytes are not useful for FTS, embeddings, or associative recall.

Current behavior:

- `safePutNode()` protects the graph from non-memory payloads;
- only text-like user/assistant content is eligible for memory insertion;
- screenshots stay in the session archive, not in `graph.db` as semantic nodes.

If image understanding is needed later, it should be added as a separate multimodal
pipeline that extracts text/captions/facts from images and inserts **those derived facts**
into memory. The original image file should remain a transcript asset.

## Source of truth

There are three different persistence layers, each with a different purpose:

| Layer | Stores images? | Purpose |
|---|---:|---|
| OpenCode `opencode.db` | Yes, original `file` parts with data URI | Host-level full session record |
| Transcript Markdown + assets | Yes, decoded sidecar files + `![image](...)` links | Human-readable archive |
| Memory graph `graph.db` | No raw images | Semantic recall over text/facts |

## Validation performed

The implementation was validated against real `opencode.db` file parts from a long-running
session. Three `file` parts were extracted; two unique PNG files were written by content
hash. `file(1)` confirmed both were valid PNG images (`2000 x 1293`, RGBA), and the
Markdown references were generated as expected.
