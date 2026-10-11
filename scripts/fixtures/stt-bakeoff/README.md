# Speech-to-text bake-off fixtures (OPE-2470)

`npm run bakeoff:stt` replays these files offline, and `npm run test:stt-bakeoff` scores them in the
`test` chain. `npm run bakeoff:stt -- --live --record <dir>` writes new ones.

- `ES2002a.ref.json` holds the reference words of AMI meeting ES2002a, 60 s to 300 s of the mixed
  headset audio. Times are seconds from the start of that excerpt.
- `responses/` holds live answers from three candidates on that excerpt, recorded on 2026-10-11, once
  with the bot's fixed 60-second cuts and once with the pause rule. They are real model output, not
  synthetic. MAI-Transcribe-2 is absent: the recording team's AI Gateway Provider Allowlist refused
  azure. Qwen3-ASR is absent: no DeepInfra key was available.
- `catalogue.json` holds the AI Gateway catalogue rows (type, ZDR, price) of the candidates, and the
  DeepInfra list prices, as checked on 2026-10-11.

## Attribution

The reference words and the audio the responses transcribe come from the **AMI Meeting Corpus**
(University of Edinburgh, IDIAP and TNO), released under the
[Creative Commons Attribution 4.0 International licence](https://creativecommons.org/licenses/by/4.0/).
Source: <https://groups.inf.ed.ac.uk/ami/corpus/>. The reference words are an excerpt of the manual
annotation release 1.6.2 (`words/ES2002a.*.words.xml`), with punctuation tokens removed and the four
speakers merged into one timeline. The audio is not committed.
