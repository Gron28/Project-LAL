# Media artifact foundation

Slice 8 begins with `web/src/lib/media-artifacts.ts`. It is a local-only,
content-addressed byte store for images, audio, video, PDFs, and other media
artifacts. It accepts either a strict base64 `data:` URL or a pre-existing,
absolute local file whose canonical path was explicitly authorized by the
caller. It does not fetch URLs, execute a decoder, run a media tool, generate a
preview, or retain source paths.

Each immutable item has a `media:sha256:<digest>` ID and private bytes outside
the checkout. Reads take an independently authenticated subject/capability
claim, require the `media.artifact.read` capability plus a metadata grant, and
rehash the bytes before returning them. The serving contract specifies
attachment disposition and callers must set `X-Content-Type-Options: nosniff`;
there is intentionally no unauthenticated HTTP serving route yet.

`MediaObservationJobInput` and `MediaTranscriptJobInput` are typed workload
contracts for later durable-job adapters. They refer only to immutable artifact
IDs and explicitly describe observation/transcription; no media execution is
part of this foundation.
