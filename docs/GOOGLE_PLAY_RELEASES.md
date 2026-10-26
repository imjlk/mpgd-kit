# Google Play releases: tracks, staged rollout, notes and draft apps

`mpgd deploy submit` and `mpgd deploy run` send a verified AAB to Google Play
through the Android Publisher API v3 edits workflow. With no release flags they
add a `completed` release to the **internal** track, exactly as before
([internal submission](./GOOGLE_PLAY_INTERNAL_SUBMISSION.md)). The flags below
choose another track, a draft, or a staged rollout, attach release notes and an
R8 mapping file. `mpgd deploy rollout` changes a release that is already on a
track (fraction, halt, resume, complete), and `mpgd deploy promote` releases a
build already on one track on another; neither uploads a bundle.

Sources: [APKs and Tracks](https://developers.google.com/android-publisher/tracks)
(last updated 2025-12-18),
[`edits.tracks`](https://developers.google.com/android-publisher/api-ref/rest/v3/edits.tracks),
[`edits.deobfuscationfiles.upload`](https://developers.google.com/android-publisher/api-ref/rest/v3/edits.deobfuscationfiles/upload),
[`edits.commit`](https://developers.google.com/android-publisher/api-ref/rest/v3/edits/commit),
[`edits.testers`](https://developers.google.com/android-publisher/api-ref/rest/v3/edits.testers),
[Prepare and roll out a release](https://support.google.com/googleplay/android-developer/answer/9859348)
and [App testing requirements for new personal developer accounts](https://support.google.com/googleplay/android-developer/answer/14151465),
all read on 2026-10-26.

## Submitting a release

```sh
# Closed testing (the track must already exist in Play Console)
pnpm exec mpgd deploy submit --plan /tmp/release-plan.json \
  --game-id mygame --release launch-001 --target android --approve \
  --track alpha --release-notes ./release-notes.txt

# Production, 5% staged rollout
pnpm exec mpgd deploy run --plan /tmp/release-plan.json \
  --game-id mygame --game-version 1.0.1 --release launch-002 --approve \
  --track production --status inProgress --user-fraction 0.05 \
  --release-notes ./release-notes.txt --confirm-production

# Print the planned edit for a recorded build; no Google Play call
pnpm exec mpgd deploy submit --plan /tmp/release-plan.json \
  --game-id mygame --release launch-002 --target android \
  --track production --status inProgress --user-fraction 0.05 --dry-run
```

| Flag | Meaning |
| --- | --- |
| `--track` | `internal` (default), `alpha`, `beta`, `production`, a closed-testing track's name, or a form-factor track such as `wear:production`. The name goes to `edits.tracks.get/update` unchanged. |
| `--status` | `completed` (default), `draft`, or `inProgress` (a staged rollout). A new release cannot start `halted`; halt it with `deploy rollout`. |
| `--user-fraction` | Required with `inProgress`, refused otherwise. Play's range is "0 < fraction < 1"; use `completed` for 100%. |
| `--release-notes` | A notes file, validated before any request (below). |
| `--mapping-file` | `deploy submit` only: the R8 `mapping.txt` of this exact build (below). |
| `--confirm-production` | Required for any `production` track (including form-factor production tracks) and for every `inProgress` release. |
| `--dry-run` | `deploy submit` only: verifies the recorded build and prints the planned edit as JSON. |

Track names. The kit has always sent `internal`, and keeps it as the default.
Google's current tracks guide lists the internal testing track as `"qa"`
("The internal testing track: "qa""); `--track qa` is passed through as
written. `internal` is what the kit and widely used publishers send today; no
live account was used to confirm which of the two Play now prefers. Testing
tracks such as `alpha` and `beta` and custom closed-testing tracks ("Closed
testing tracks are created manually and they have custom names") work the same
way. The kit does not create tracks (`edits.tracks.create` exists for closed
testing tracks; create them in Play Console).

What changes on the track. Play's `Track.releases` in an update request
"represents desired changes". The kit reads the track in the edit, then sends
every release back as Play returned it, plus the new one, except the releases
the new one supersedes:

- a `completed` or `inProgress` release replaces an `inProgress` or `halted`
  rollout on that track;
- a `draft` replaces an older `draft` on that track;
- `completed` releases are always kept. A track with only completed releases
  (the usual internal track) gets the same body the kit sent before.

No other track is read or written. The commit uses
`changesInReviewBehavior=ERROR_IF_IN_REVIEW`, so changes already in review are
not cancelled.

A staged rollout needs a completed release on the track to stage over. Play
Console says "Rollout percentage options are unavailable for a first
release", so the kit refuses `inProgress` on a track without a completed
release, before uploading.

Approval and confirmation. A non-dry run needs `--approve`, or a profile with
`approval: "preapproved-internal-test"`; that preapproval covers only the
internal track. `--confirm-production` is required in addition for production
and staged releases, and is checked before anything is reserved, built, or
sent. `deploy run` passes the flags to the Android target only.

Resumes. The release options (track, status, fraction, notes, mapping hash)
are hashed into the Android submission checkpoint as `playReleaseSha256`. The
kit checkpoints a new Play edit only after its read-only checks (bundle
conflict, the track's current releases, a missing closed-testing track, the
first-release rollout rule), so a request refused there leaves no edit and can
be re-run with corrected options. Once an edit is checkpointed, a resumed
attempt must use the same options, so an open edit is never committed to a
different track or status. A committed release cannot be re-submitted
with other options: change it with `deploy rollout` or submit a new release.
The original internal/completed submission has no digest, so its checkpoints
are unchanged. A release-state file written by this version can carry the new
field, which older CLI versions reject as malformed.

## Release notes

Play Console accepts "up to 500 Unicode characters per language" and enters
notes in language-tag blocks. The file uses the same format:

```text
<en-US>
Faster loading and a new stage.
</en-US>
<ko-KR>
로딩이 빨라지고 새 스테이지가 추가되었습니다.
</ko-KR>
```

JSON also works: `{ "en-US": "…", "ko-KR": "…" }` or
`[{ "language": "en-US", "text": "…" }]`. Each block is trimmed; the kit
refuses text outside the tags, a repeated language, a tag that is not BCP-47,
empty notes, and more than 500 characters (code points) per language. The
notes go to the new release's `releaseNotes` (`LocalizedText` with `language`
and `text`). A draft-app fallback keeps them.

## R8 mapping (deobfuscation file)

With `minifyEnabled true`, the Android Gradle build writes
`android/app/build/outputs/mapping/release/mapping.txt`. Pass that file from
the same build to `deploy submit --mapping-file`. The kit hashes it when the
command starts, refuses it if it changes before upload, and uploads it with
`edits.deobfuscationfiles.upload` (`deobfuscationFileType=proguard`, the
release's version code) in the same edit, before the track update. A lost
upload response is retried on the same edit when the submission resumes; a
re-upload replaces the edit's file. The kit's shell ships with
`minifyEnabled false`, and `deploy run` does not yet capture the mapping file
into the immutable build record, so it is the operator's job to pass the
mapping of the recorded build.

## Draft apps

An app that has never been published accepts only draft releases through the
API. Play then answers `400` "Only releases with status draft may be created on
draft app.". Google's API reference does not document this; it is reported by
users of [fastlane](https://github.com/fastlane/fastlane/discussions/29514),
[upload-google-play](https://github.com/r0adkll/upload-google-play/issues/70)
and the [Azure DevOps extension](https://github.com/microsoft/google-play-vsts-extension/issues/467),
where it comes back from `edits.commit`. The kit was not run against a live
draft app.

When `edits.validate` or `edits.commit` returns that definitive rejection (a
4xx with that text, so nothing was committed), the kit re-stages the same
version as a `draft` in the same edit (without `userFraction`, keeping the
notes), validates and commits it, prints a warning, and reports
`releaseStatus: "draft"` and `draftAppFallback: true`. The draft serves no
one. Finish the app's first release once in Play Console: open the track's
draft release, review it, and roll it out (Play Console: "Rollout percentage
options are unavailable for a first release"). Later submissions can use their
normal status. If the edit is gone after the rejection, the submission is left
`unknown` for the usual resume.

## Changing a rollout (`deploy rollout`)

```sh
pnpm exec mpgd deploy rollout --plan /tmp/release-plan.json --track production \
  --action update --user-fraction 0.2 --approve --confirm-production
pnpm exec mpgd deploy rollout --plan /tmp/release-plan.json --track production \
  --action halt --approve --confirm-production
pnpm exec mpgd deploy rollout --plan /tmp/release-plan.json --track production \
  --action resume --approve --confirm-production   # same fraction as before the halt
pnpm exec mpgd deploy rollout --plan /tmp/release-plan.json --track production \
  --action complete --approve --confirm-production
```

The plan supplies the package ID and the Android submission credential. The
command opens an edit, reads only the named track, changes one release and
sends every other release back unchanged (including fields such as
`countryTargeting`), then validates and commits. Play's tracks guide describes
each step:

| Action | Release | Result |
| --- | --- | --- |
| `update` | `inProgress` | new `userFraction` (`--user-fraction` required) |
| `halt` | `inProgress`, or a `completed` release named with `--version-code` | `halted` (the fraction is kept). Halting a completed release serves the previous completed one; Play allows it only if one exists. |
| `resume` | `halted` | `inProgress` with `--user-fraction`, or the fraction it had |
| `complete` | `inProgress` or `halted` | `completed`, `userFraction` removed |

Without `--version-code`, the track must have exactly one release the action
applies to. A release already in the requested state reports `unchanged` and
commits nothing. A lost response raises `PlayRolloutUncertainError` with the
release's version codes; re-run the same command with `--version-code` from
the error (needed after `complete`, whose release is then no longer in
progress). It is safe because it reads the live track first.
`update` and `resume` leave a staged rollout running, so they always need
`--confirm-production`; `halt` and `complete` need it on production tracks.
`--dry-run` reads the track in a new edit, prints the planned track body, and
deletes the edit. Every rollout command opens an edit, which invalidates any
other open edit of the same service account, so do not run one while a
submission is in flight or left `unknown`; that submission then has to reopen
a fresh edit when it resumes.

## Promoting a tested release (`deploy promote`)

The build that passed testing should be the one that reaches production, not a
rebuild. A version code uploaded once is released on any track by
`Edits.tracks: update` with that version code
([APKs and Tracks](https://developers.google.com/android-publisher/tracks)), so
promotion uploads nothing:

```sh
# Dry run: read both tracks, print the planned production body, discard the edit
pnpm exec mpgd deploy promote --plan /tmp/release-plan.json \
  --from "Closed testers" --to production --status inProgress --user-fraction 0.05 --dry-run

pnpm exec mpgd deploy promote --plan /tmp/release-plan.json \
  --from "Closed testers" --to production --status inProgress --user-fraction 0.05 \
  --approve --confirm-production
```

| Flag | Meaning |
| --- | --- |
| `--from` | Source track. It must exist and hold the release. |
| `--to` | Target track, the only track that changes. A closed-testing target must already exist. |
| `--version-code` | Version to promote. Without it, the source track must have exactly one `completed` release, and all its version codes are promoted. A version code that is not on the source track is refused. |
| `--status` | Target status: `completed` (default), `draft`, or `inProgress` with `--user-fraction`. |
| `--release-notes` | A notes file (same format as above). Without it, the source release's notes are copied. |
| `--approve` | Required unless `--dry-run`. |
| `--confirm-production` | Required for a production target and any `inProgress` promotion, checked before any request. |
| `--dry-run` | Opens an edit, reads both tracks, prints the planned target body, and deletes the edit. |

Rules:

- Only a `completed` or `inProgress` source release is promoted. A `draft` was
  never served to testers, and a `halted` one was stopped; both are refused.
- The promoted release keeps the source release's name. On the target track
  it is merged like a submission: it replaces an `inProgress` or `halted`
  rollout (a draft replaces an older draft), and every other release is sent
  back unchanged. The result lists the replaced releases in `superseded`.
- A staged promotion needs a completed release on the target track, as for a
  submission ("Rollout percentage options are unavailable for a first
  release").
- If the target track already has the version with the same status, fraction
  and (when given) notes, the command reports `unchanged` and commits nothing;
  with other options it is refused, so change it with `deploy rollout`.
- A lost response raises `PlayPromoteUncertainError` with the version codes;
  re-run with `--version-code` from the error. Promote does not touch the
  release-state checkpoints: the build was already submitted and verified.
- Like `deploy rollout`, it opens an edit, so do not run it while a submission
  is in flight or left `unknown`.

## Closed testing for new personal accounts

Personal developer accounts created after 13 November 2023 must run "a closed
test with a minimum of 12 testers who have been opted in continuously for at
least 14 days" before they can apply for production (Play Console → Dashboard
→ Apply for production). The kit's part is the release:

1. Create a closed testing track in Play Console (or use `alpha`) and note its
   name exactly as Play shows it.
2. `mpgd deploy run … --track <that name>` (or `deploy submit`) puts each build
   on it. Keep testers on the newest build for the whole 14 days.
3. After production access is granted, promote the tested build:
   `mpgd deploy promote --from <that name> --to production …`.
4. Testers, the opt-in link, countries and the production-access application
   stay in Play Console. The API's `edits.testers` resource takes only Google
   Groups ("email lists are not supported by this resource"); the kit does not
   set testers.

## Verify on the first live run

These behaviours are mock-tested only. Check them on the first submission to
a real Play account (the D-12 live run) and correct the kit if Play disagrees:

- [ ] **Internal track name.** The kit sends `internal`; Google's tracks guide
      lists the internal testing track as `"qa"`. Confirm that `edits.tracks.get`
      and `update` accept `internal` (and see what `track` Play returns), or
      switch the default to `qa`.
- [ ] **Track update body.** For a `completed` release the kit sends the
      track's existing completed releases plus the new one (the body the kit
      has always sent on the internal track). gradle-play-publisher sends only
      the new release. Confirm Play accepts the kit's body on internal, a
      closed track and production, and that the previous completed release
      stops serving as expected.
- [ ] **Draft app.** On a never-published app, confirm that a `completed`
      submission is rejected with "Only releases with status draft may be
      created on draft app.", on `edits.commit` (or `edits.validate`), that the
      kit's same-edit draft fallback commits, and that the draft can then be
      rolled out from Play Console. Note whether the rejected edit is still
      usable.

## Tests

```sh
pnpm smoke:cli-play-internal-submission
pnpm smoke:cli-native-deploy
pnpm smoke:cli-release-state
```

The first runs both mock-transport suites through the pinned Google SDK
adapter: the original internal cases and
`adapters/play-publisher/src/play-release.test.ts` (staged rollout, refusals
without confirmation, supersession, first-release refusal, draft-app fallback,
closed track, mapping upload, dry run, every rollout action, and promote). No live Play
Console account was used.
