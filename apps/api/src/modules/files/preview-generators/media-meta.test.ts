import { describe, expect, it } from 'vitest';
import { generatorFor, previewMimeTypes, previewPlanFor } from './index.js';
import { createMediaMetaGenerator, mediaFactsFrom, mediaMetaGenerator } from './media-meta.js';
import type { MediaFacts, MediaTrack } from './media-meta.js';
import { DEFAULT_PREVIEW_LIMITS } from './types.js';
import type { PreviewOutcome, PreviewRequest } from './types.js';

/**
 * R4 slice 9 — video and audio facts. The real MediaInfo WASM reads tiny files made with ffmpeg
 * once (1 s, 32 × 24 px, kept here as base64 so no binary file is checked in); the playability
 * rules are also checked on hand-written track lists.
 */

const META: PreviewRequest = { kind: 'media_meta', pageNo: 0 };

/* prettier-ignore */
const FIXTURES = {
  H264_MP4: [
    'AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAWfbW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAfQAAAH0AAAQAA',
    'AQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    'AAAAAwAAAll0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAH0AAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAA',
    'AAAAAAABAAAAAAAAAAAAAAAAAABAAAAAACAAAAAYAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAB9AAAAAAAABAAAAAAHR',
    'bWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAABAAAAAQABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRl',
    'b0hhbmRsZXIAAAABfG1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAA',
    'AQAAATxzdGJsAAAAuHN0c2QAAAAAAAAAAQAAAKhhdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAACAAGABIAAAASAAAAAAA',
    'AAABFExhdmM2My4xLjEwMiBsaWJ4MjY0AAAAAAAAAAAAAAAAGP//AAAALmF2Y0MBQsAK/+EAF2dCwAraJflwEQAAAwABAAAD',
    'AAQPEiagAQAEaM4PyAAAABBwYXNwAAAAAQAAAAEAAAAUYnRydAAAAAAAABPQAAAAAAAAABhzdHRzAAAAAAAAAAEAAAACAAAg',
    'AAAAABRzdHNzAAAAAAAAAAEAAAABAAAAHHN0c2MAAAAAAAAAAQAAAAEAAAABAAAAAQAAABxzdHN6AAAAAAAAAAAAAAACAAAC',
    'cAAAAAoAAAAYc3RjbwAAAAAAAAACAAAF4gAACGIAAAJxdHJhawAAAFx0a2hkAAAAAwAAAAAAAAAAAAAAAgAAAAAAAB9AAAAA',
    'AAAAAAAAAAABAQAAAAABAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAJGVkdHMAAAAcZWxz',
    'dAAAAAAAAAABAAAfQAAABAAAAQAAAAAB6W1kaWEAAAAgbWRoZAAAAAAAAAAAAAAAAAAAH0AAACNAVcQAAAAAAC1oZGxyAAAA',
    'AAAAAABzb3VuAAAAAAAAAAAAAAAAU291bmRIYW5kbGVyAAAAAZRtaW5mAAAAEHNtaGQAAAAAAAAAAAAAACRkaW5mAAAAHGRy',
    'ZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAVhzdGJsAAAAfnN0c2QAAAAAAAAAAQAAAG5tcDRhAAAAAAAAAAEAAAAAAAAAAAAB',
    'ABAAAAAAH0AAAAAAADZlc2RzAAAAAAOAgIAlAAIABICAgBdAFQAAAAAAH0AAAAFpBYCAgAUViFblAAaAgIABAgAAABRidHJ0',
    'AAAAAAAAH0AAAAFpAAAAIHN0dHMAAAAAAAAAAgAAAAgAAAQAAAAAAQAAA0AAAAAoc3RzYwAAAAAAAAACAAAAAQAAAAEAAAAB',
    'AAAAAgAAAAQAAAABAAAAOHN0c3oAAAAAAAAAAAAAAAkAAAATAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAc',
    'c3RjbwAAAAAAAAADAAAFzwAACFIAAAhsAAAAGnNncGQBAAAAcm9sbAAAAAIAAAAB//8AAAAcc2JncAAAAAByb2xsAAAAAQAA',
    'AAkAAAABAAAAYXVkdGEAAABZbWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAbWRpcmFwcGwAAAAAAAAAAAAAAAAsaWxzdAAAACSp',
    'dG9vAAAAHGRhdGEAAAABAAAAAExhdmY2My4xLjEwMgAAAAhmcmVlAAACtW1kYXTcAExhdmM2My4xLjEwMgACMEAOAAACUwYF',
    '//9P3EXpvebZSLeWLNgg2SPu73gyNjQgLSBjb3JlIDE2NSByMzIyMyAwNDgwY2IwIC0gSC4yNjQvTVBFRy00IEFWQyBjb2Rl',
    'YyAtIENvcHlsZWZ0IDIwMDMtMjAyNSAtIGh0dHA6Ly93d3cudmlkZW9sYW4ub3JnL3gyNjQuaHRtbCAtIG9wdGlvbnM6IGNh',
    'YmFjPTAgcmVmPTEgZGVibG9jaz0wOjA6MCBhbmFseXNlPTA6MCBtZT1kaWEgc3VibWU9MCBwc3k9MSBwc3lfcmQ9MS4wMDow',
    'LjAwIG1peGVkX3JlZj0wIG1lX3JhbmdlPTE2IGNocm9tYV9tZT0xIHRyZWxsaXM9MCA4eDhkY3Q9MCBjcW09MCBkZWFkem9u',
    'ZT0yMSwxMSBmYXN0X3Bza2lwPTEgY2hyb21hX3FwX29mZnNldD0wIHRocmVhZHM9MSBsb29rYWhlYWRfdGhyZWFkcz0xIHNs',
    'aWNlZF90aHJlYWRzPTAgbnI9MCBkZWNpbWF0ZT0xIGludGVybGFjZWQ9MCBibHVyYXlfY29tcGF0PTAgY29uc3RyYWluZWRf',
    'aW50cmE9MCBiZnJhbWVzPTAgd2VpZ2h0cD0wIGtleWludD0yNTAga2V5aW50X21pbj0yIHNjZW5lY3V0PTAgaW50cmFfcmVm',
    'cmVzaD0wIHJjPWNyZiBtYnRyZWU9MCBjcmY9MjMuMCBxY29tcD0wLjYwIHFwbWluPTAgcXBtYXg9NjkgcXBzdGVwPTQgaXBf',
    'cmF0aW89MS40MCBhcT0wAIAAAAAVZYiEOhGKAAIY8cAAQPY4AAh5SddeARggBwEYIAcBGCAHARggBwAAAAZBmiASosABGCAH',
    'ARggBwEYIAcBGCAH',
  ].join(''),
  HEVC_MOV: [
    'AAAAFGZ0eXBxdCAgAAACAHF0ICAAAAAId2lkZQAAACxtZGF0AAAAFCgBreDFp//3TniPS+/9zfJGLUG+AAAACAIB0Al4j5zr',
    'AAAMe21vb3YAAABsbXZoZAAAAAAAAAAAAAAAAAAAA+gAAAPoAAEAAAEAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAQAA',
    'AAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIAAAvndHJhawAAAFx0a2hkAAAAAwAAAAAAAAAA',
    'AAAAAQAAAAAAAAPoAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAQAAAAABAAAAAMAAA',
    'AAAAJGVkdHMAAAAcZWxzdAAAAAAAAAABAAAD6AAAAAAAAQAAAAALX21kaWEAAAAgbWRoZAAAAAAAAAAAAAAAAAAAQAAAAEAA',
    'f/8AAAAAAC1oZGxyAAAAAG1obHJ2aWRlAAAAAAAAAAAAAAAADFZpZGVvSGFuZGxlcgAACwptaW5mAAAAFHZtaGQAAAABAAAA',
    'AAAAAAAAAAAsaGRscgAAAABkaGxydXJsIAAAAAAAAAAAAAAAAAtEYXRhSGFuZGxlcgAAACRkaW5mAAAAHGRyZWYAAAAAAAAA',
    'AQAAAAx1cmwgAAAAAQAACp5zdGJsAAAKHnN0c2QAAAAAAAAAAQAACg5odmMxAAAAAAAAAAEAAAAARkZNUAAAAgAAAAIAAEAA',
    'MABIAAAASAAAAAAAAAABFExhdmM2My4xLjEwMiBsaWJ4MjY1AAAAAAAAAAAAAAAAGP//AAAJnmh2Y0MBAWAAAACQAAAAAAAe',
    '8AD8/fj4AAAPBKAAAQAYQAEMAf//AWAAAAMAkAAAAwAAAwAelZQJoQABAClCAQEBYAAAAwCQAAADAAADAB6gIIMWWVlSkwvA',
    'WgIAAAMAAgAAAwAEEKIAAQAGRAHAc8CJJwABCSROAQX///////////8fLKLeCbUXR9u7VaT+f8L8TngyNjUgKGJ1aWxkIDIx',
    'NykgLSA0LjMrNDUtMTE2Yjg3NTpbV2luZG93c11bR0NDIDE2LjIuMF1bNjQgYml0XSA4Yml0KzEwYml0KzEyYml0IC0gSC4y',
    'NjUvSEVWQyBjb2RlYyAtIENvcHlyaWdodCAyMDEzLTIwMTggKGMpIE11bHRpY29yZXdhcmUsIEluYyAtIGh0dHA6Ly94MjY1',
    'Lm9yZyAtIG9wdGlvbnM6IGNwdWlkPTExMTEwMzkgZnJhbWUtdGhyZWFkcz0xIG51bWEtcG9vbHM9MTYgbm8td3BwIG5vLXBt',
    'b2RlIG5vLXBtZSBuby1wc25yIG5vLXNzaW0gbG9nLWxldmVsPS0xIGJpdGRlcHRoPTggaW5wdXQtY3NwPTEgZnBzPTIvMSBp',
    'bnB1dC1yZXM9NjR4NDggaW50ZXJsYWNlPTAgdG90YWwtZnJhbWVzPTAgbGV2ZWwtaWRjPTAgaGlnaC10aWVyPTEgdWhkLWJk',
    'PTAgcmVmPTEgbm8tYWxsb3ctbm9uLWNvbmZvcm1hbmNlIG5vLXJlcGVhdC1oZWFkZXJzIGFubmV4YiBuby1hdWQgbm8tZW9i',
    'IG5vLWVvcyBuby1ocmQgaW5mbyBoYXNoPTAgdGVtcG9yYWwtbGF5ZXJzPTAgb3Blbi1nb3AgbWluLWtleWludD0yIGtleWlu',
    'dD0yNTAgZ29wLWxvb2thaGVhZD0wIGJmcmFtZXM9MyBiLWFkYXB0PTAgYi1weXJhbWlkIGJmcmFtZS1iaWFzPTAgcmMtbG9v',
    'a2FoZWFkPTUgbG9va2FoZWFkLXNsaWNlcz0wIHNjZW5lY3V0PTAgbm8taGlzdC1zY2VuZWN1dCByYWRsPTAgbm8tc3BsaWNl',
    'IG5vLWludHJhLXJlZnJlc2ggY3R1PTMyIG1pbi1jdS1zaXplPTE2IG5vLXJlY3Qgbm8tYW1wIG1heC10dS1zaXplPTMyIHR1',
    'LWludGVyLWRlcHRoPTEgdHUtaW50cmEtZGVwdGg9MSBsaW1pdC10dT0wIHJkb3EtbGV2ZWw9MCBkeW5hbWljLXJkPTAuMDAg',
    'bm8tc3NpbS1yZCBuby1zaWduaGlkZSBuby10c2tpcCBuci1pbnRyYT0wIG5yLWludGVyPTAgbm8tY29uc3RyYWluZWQtaW50',
    'cmEgc3Ryb25nLWludHJhLXNtb290aGluZyBtYXgtbWVyZ2U9MiBsaW1pdC1yZWZzPTAgbm8tbGltaXQtbW9kZXMgbWU9MCBz',
    'dWJtZT0wIG1lcmFuZ2U9NTcgdGVtcG9yYWwtbXZwIG5vLWZyYW1lLWR1cCBuby1obWUgbm8td2VpZ2h0cCBuby13ZWlnaHRi',
    'IG5vLWFuYWx5emUtc3JjLXBpY3MgZGVibG9jaz0wOjAgbm8tc2FvIG5vLXNhby1ub24tZGVibG9jayByZD0yIHNlbGVjdGl2',
    'ZS1zYW89MCBlYXJseS1za2lwIHJza2lwIGZhc3QtaW50cmEgbm8tdHNraXAtZmFzdCBuby1jdS1sb3NzbGVzcyBuby1iLWlu',
    'dHJhIG5vLXNwbGl0cmQtc2tpcCByZHBlbmFsdHk9MCBwc3ktcmQ9Mi4wMCBwc3ktcmRvcT0wLjAwIG5vLXJkLXJlZmluZSBu',
    'by1sb3NzbGVzcyBjYnFwb2Zmcz0wIGNycXBvZmZzPTAgcmM9Y3JmIGNyZj0yOC4wIHFjb21wPTAuNjAgcXBzdGVwPTQgc3Rh',
    'dHMtd3JpdGU9MCBzdGF0cy1yZWFkPTAgaXByYXRpbz0xLjQwIHBicmF0aW89MS4zMCBhcS1tb2RlPTEgYXEtc3RyZW5ndGg9',
    'MC4wMCBjdXRyZWUgem9uZS1jb3VudD0wIG5vLXN0cmljdC1jYnIgcWctc2l6ZT0zMiBuby1yYy1ncmFpbiBxcG1heD02OSBx',
    'cG1pbj0wIG5vLWNvbnN0LXZidiBzYXI9MSBvdmVyc2Nhbj0wIHZpZGVvZm9ybWF0PTUgcmFuZ2U9MCBjb2xvcnByaW09MiB0',
    'cmFuc2Zlcj0yIGNvbG9ybWF0cml4PTIgY2hyb21hbG9jPTAgZGlzcGxheS13aW5kb3c9MCBjbGw9MCwwIG1pbi1sdW1hPTAg',
    'bWF4LWx1bWE9MjU1IGxvZzItbWF4LXBvYy1sc2I9OCB2dWktdGltaW5nLWluZm8gdnVpLWhyZC1pbmZvIHNsaWNlcz0xIG5v',
    'LW9wdC1xcC1wcHMgbm8tb3B0LXJlZi1saXN0LWxlbmd0aC1wcHMgbm8tbXVsdGktcGFzcy1vcHQtcnBzIHNjZW5lY3V0LWJp',
    'YXM9MC4wNSBuby1vcHQtY3UtZGVsdGEtcXAgbm8tYXEtbW90aW9uIG5vLWhkcjEwIG5vLWhkcjEwLW9wdCBuby1kaGRyMTAt',
    'b3B0IG5vLWlkci1yZWNvdmVyeS1zZWkgYW5hbHlzaXMtcmV1c2UtbGV2ZWw9MCBhbmFseXNpcy1zYXZlLXJldXNlLWxldmVs',
    'PTAgYW5hbHlzaXMtbG9hZC1yZXVzZS1sZXZlbD0wIHNjYWxlLWZhY3Rvcj0wIHJlZmluZS1pbnRyYT0wIHJlZmluZS1pbnRl',
    'cj0wIHJlZmluZS1tdj0xIHJlZmluZS1jdHUtZGlzdG9ydGlvbj0wIG5vLWxpbWl0LXNhbyBjdHUtaW5mbz0wIG5vLWxvd3Bh',
    'c3MtZGN0IHJlZmluZS1hbmFseXNpcy10eXBlPTAgY29weS1waWM9MSBtYXgtYXVzaXplLWZhY3Rvcj0xLjAgbm8tZHluYW1p',
    'Yy1yZWZpbmUgbm8tc2luZ2xlLXNlaSBuby1oZXZjLWFxIG5vLXN2dCBuby1maWVsZCBxcC1hZGFwdGF0aW9uLXJhbmdlPTEu',
    'MDAgc2NlbmVjdXQtYXdhcmUtcXA9MGNvbmZvcm1hbmNlLXdpbmRvdy1vZmZzZXRzIHJpZ2h0PTAgYm90dG9tPTAgZGVjb2Rl',
    'ci1tYXgtcmF0ZT0wIG5vLXZidi1saXZlLW11bHRpLXBhc3Mgbm8tbWNzdGYgbm8tc2JyYyBuby1mcmFtZS1yY4AAAAAKZmll',
    'bAEAAAAAEHBhc3AAAAABAAAAAQAAABhzdHRzAAAAAAAAAAEAAAACAAAgAAAAABRzdHNzAAAAAAAAAAEAAAABAAAAHHN0c2MA',
    'AAAAAAAAAQAAAAEAAAACAAAAAQAAABxzdHN6AAAAAAAAAAAAAAACAAAAGAAAAAwAAAAUc3RjbwAAAAAAAAABAAAAJAAAACB1',
    'ZHRhAAAAGKlzd3IADFXETGF2ZjYzLjEuMTAy',
  ].join(''),
  PRORES_MOV: [
    'AAAAFGZ0eXBxdCAgAAACAHF0ICAAAAAId2lkZQAAAZRtZGF0AAAAxmljcGYAlAAATGF2YwAgABiAAAICAgAAAwQHCQsNDg8/',
    'BwcLDA4PPz8JCw0ODz8/PwsLDQ4/Pz8/Cw0OPz8/Pz8NDj8/Pz8/Pw0/Pz8/Pz8/Pz8/Pz8/Pz8EBwkLDQ4/PwcHCwwOPz8/',
    'CQsNDj8/Pz8LCw0OPz8/PwsNDj8/Pz8/DQ4/Pz8/Pz8NPz8/Pz8/Pz8/Pz8/Pz8/QAAAACoAAjAADwAPMAgAAwADGXj8FHjA',
    'GXjAMAgAAwADGXj8FHjAGXjAAAAAxmljcGYAlAAATGF2YwAgABiAAAICAgAAAwQHCQsNDg8/BwcLDA4PPz8JCw0ODz8/PwsL',
    'DQ4/Pz8/Cw0OPz8/Pz8NDj8/Pz8/Pw0/Pz8/Pz8/Pz8/Pz8/Pz8EBwkLDQ4/PwcHCwwOPz8/CQsNDj8/Pz8LCw0OPz8/PwsN',
    'Dj8/Pz8/DQ4/Pz8/Pz8NPz8/Pz8/Pz8/Pz8/Pz8/QAAAACoAAjAADwAPMAgAAwADGXj8FHjAGXjAMAgAAwADGXj8FHjAGXjA',
    'AAACwW1vb3YAAABsbXZoZAAAAAAAAAAAAAAAAAAAA+gAAAPoAAEAAAEAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAQAA',
    'AAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIAAAItdHJhawAAAFx0a2hkAAAAAwAAAAAAAAAA',
    'AAAAAQAAAAAAAAPoAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAQAAAAAAgAAAAGAAA',
    'AAAAJGVkdHMAAAAcZWxzdAAAAAAAAAABAAAD6AAAAAAAAQAAAAABpW1kaWEAAAAgbWRoZAAAAAAAAAAAAAAAAAAAQAAAAEAA',
    'f/8AAAAAAC1oZGxyAAAAAG1obHJ2aWRlAAAAAAAAAAAAAAAADFZpZGVvSGFuZGxlcgAAAVBtaW5mAAAAFHZtaGQAAAABAAAA',
    'AAAAAAAAAAAsaGRscgAAAABkaGxydXJsIAAAAAAAAAAAAAAAAAtEYXRhSGFuZGxlcgAAACRkaW5mAAAAHGRyZWYAAAAAAAAA',
    'AQAAAAx1cmwgAAAAAQAAAORzdGJsAAAAgHN0c2QAAAAAAAAAAQAAAHBhcGNvAAAAAAAAAAEAAAAARkZNUAAAAgAAAAIAACAA',
    'GABIAAAASAAAAAAAAAABFkxhdmM2My4xLjEwMiBwcm9yZXNfa3MAAAAAAAAAAAAAGP//AAAACmZpZWwBAAAAABBwYXNwAAAA',
    'AQAAAAEAAAAYc3R0cwAAAAAAAAABAAAAAgAAIAAAAAAcc3RzYwAAAAAAAAABAAAAAQAAAAIAAAABAAAAFHN0c3oAAAAAAAAA',
    'xgAAAAIAAAAUc3RjbwAAAAAAAAABAAAAJAAAACB1ZHRhAAAAGKlzd3IADFXETGF2ZjYzLjEuMTAy',
  ].join(''),
  MP3: [
    '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',
  ].join(''),
  OPUS_OGG: [
    'T2dnUwACAAAAAAAAAABmMWTBAAAAAKAMPRQBE09wdXNIZWFkAQE4AUAfAAAAAABPZ2dTAAAAAAAAAAAAAGYxZMEBAAAAA90Z',
    'NQE8T3B1c1RhZ3MMAAAATGF2ZjYzLjEuMTAyAQAAABwAAABlbmNvZGVyPUxhdmM2My4xLjEwMiBsaWJvcHVzT2dnUwAAgLsA',
    'AAAAAABmMWTBAgAAAGaK84kyDRoQDQ0QDhAODg8TDwwQDxAPDg0PDQ4QFBYQDg4SDA0LDA0LDg0NDg0NDA4ODQ0LDAwIg8ok',
    '48IgaDQeqk3oCKcaguu/Ms7WqhUn21cgLzna9yKppp0TH4AIoVF+TfaW/JO3Hj8MO55oCKFDJNUJu6uTVV6/SAihQyTUguLY',
    'HPGhAyAIoTYajU+p8DUTVTOgv4qUCKFIe6dWgRF5JXpn5oAIoN4kITx/zleUWCsNnmTFCJ/6xNSC4tS//lpMzpwIn/ySLXsR',
    'uH54Aam69Aif+sVZutHHEQuzgBA1IAif+sVZxNigGbq7BDq0V5hxvaAIoTN6e+klVaaAVqASN4AIoTYbQwaOdCZcSbgIoUMk',
    '1ILi18IEDSSt/1qJCKFDJVm4P8GGLh7z82fACKFDJVnE2KBVCASiHTPy9gig2xQ6nJEvcDHKDuXfQAif+sTVCbuler6Xrn/s',
    'CJ/6xNR93Ua4eqTK2Qif7bqNT6n3BWzkabmWIAif+sTSjYVYPKD2dugIn+27QwaOgW1nz1k+PAihQySverJ/PxQdNNbKBsAI',
    'oXL6yy8H/d/Sm9QmdDnr/0IycAijfRyxMAuc0UrzjTz1PUJMm29uaMUIpLdEBQFAG7dRxj7iz01fCKPT5LHic0gTRtqrpQUI',
    'o9PkseWzQLHkAegFJAijyY78A/aX8rjXvMO5SX6SYAg6lEWeMTBrUhXkpwg6rgJqyopFel+d8EAIO2S1njE8ztqL4Ag7ZLWe',
    'MTBGPYSlgAg7ZLWeLzG4RBv7ZyAIO2S1ni8RKvhM3gg6kQainnaAbEeUlnuACDqURZ4xPM+QWTDHgAg6lEWeMTCFJNESe7YI',
    'OpRFni8xRU6WsVg6UAg6lEWeLxIiSPi82tgIOpEGop5nN2fAleaDCDqURZ4xOJ+0PhD4CDqURZ4xMKq81doX/cAIOpRFni8x',
    'bbfQgum9gAg6lEWeLxxkzjRvTzYIOpEGop53QdQDrl12CDqURZ4xOJ7caGMIOpRFnjEwRrkmfqAIOpRFni8wQjnkB6BPZ2dT',
    'AAS4vAAAAAAAAGYxZMEDAAAApEyS+gELCAZN6sACHOAgnnA=',
  ].join(''),
  AAC_M4A: [
    'AAAAHGZ0eXBNNEEgAAACAE00QSBpc29taXNvMgAAAAhmcmVlAAAFMG1kYXTcAExhdmM2My4xLjEwMgACOKVS00bus/aPt8SV',
    'dy0SJEiRJINq2natp2radq4ztXGdq2menbFO2Kw7VtO1cZ2rjOVZTlW05VtNixOOxOVZSECECECESUZKMqjKpTJWlNdcrq7t',
    'zA3YpQJQMDAwMDGzcsssssspuWWWWWWU3LLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLL',
    'LLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLwBAJzZOR1E',
    'uhlEvBVkvn2+f/4v/P9euONatJ/0/T/8P/P8eeOtXd1n/T8/+n/z9dcca1Zr/0/P/p/9/rjjjjUvFl0UgcBl0ck4mmZsMVzT',
    'TL2NjZHZs2RLHIfrwXYIHCUYTrOdFVRjGoNHRRHQboHUKDdBp1UUHEatiIs2EfLct2ydC6Nr7GyKLYUvyJHBWXMs52I885zn',
    'UpUalKnnnnnnVOqdU6p5551KnnVPOqeeedU6th55556CgupQic1hSJ3D8FOdUPNPzKnn5p/l8quYifqOhSAOARLyiuLmY3zz',
    '3+f+n/261xxerkuXWpEy3fXN0B7kH/gDP7h/4zAe+gH+AHQn3BD399EIHwA77gP/Bg77kH/hsO+8IP8Nge5A+bMB76APjMLP',
    'fQYSX8Op/Hw4n8MCn8fCS8RiiZYIgDGAJBiACIRAALBULBtiERKYDgEEMofmf5/j78+r7/T//l//xnGu/r34+P03x7fbXP7+',
    'HesrVbwFf+796im/fYJKb1N5SmhTfv33b999+/few3t9yoS92/fvoCAXDUFgqFgxBKAAzACYAqEgAiEABMOAbQBQAIAOAP4y',
    'hCARQhBuv8e833+n/+j/+WccePbx15+0zXr6+3xe91K8+NYCrKen+2IPy5Z/7M/pJMJOBgYG7gbBkDAwNiwVCwS5CgUuEwmF',
    'guFQBKAAuAJgCwUCQSBcIACYWCwZ4BEUuA4A/jKH5n8/1/X7ZN+v/8P/881x4+/rXn5566+3Hft+PzUbmVgL+rZsVbNmyQUi',
    's2bGzog3bNmzY2R9WzZs2WGzZs2FQpEUBELhoCwWCwAkFIBhAFgBnDOAJAiAATCoAkAEQHAA/DKH5n6/p9fPjz3+n//L//jq',
    'cZ59+uvtpfrz68/H2XTXd4DJDfvbVN++gUb96+8pS6m/fv3799779+/fYb/Lv3lgpAUCUwmFwsFgqAJRFIhALhYAUCwUiJQC',
    'AAuEwqGULRCIlMBwASYyi+MRilVnf/9n/8+pq7kkkkSJBe9bGK1Y9KGV9y1Y9NTK+69WPTUysX9QMKrhUyvuWrT0oZX3Xq09',
    'NTK+69WPTUyvuvjx6arq+6+PHpq01yX9WOFWmvsv6scKtNaL+rFdWnpkv6u5dWmtF/ViurT0ov6u6+rT0oX1dy1aelDOrFas',
    'elDK+5c+OCGGxWrHpqZX3Xx49NTAAs67dM+2fheFtM+wEAHAAUAyi+ZRVM9fb+eLu7kkkkSRIggVz5Vsm3IVBlWybchUGVpu',
    'bc4E5XYRlaZzbkQwIaZMtxUCGm5nXIYH2m5luQwIabmW5DA+1zzOuQwPtc8zrnNAhrnmW5DAhrnmW5zbkNc+VbnNuQ1z5Vs5',
    'tyGufKtnNuQ1z5WnObc4rnytM5tzioMrTObc4rnytMm3OKgytMm3OKgfaZM64qB9pkzrioENMmW5DA+03M65DAhpubgAAAMe',
    'bW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAfQAAAH0AAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAA',
    'AAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAkl0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAAB',
    'AAAAAAAAH0AAAAAAAAAAAAAAAAEBAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAk',
    'ZWR0cwAAABxlbHN0AAAAAAAAAAEAAB9AAAAEAAABAAAAAAHBbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAAAfQAAAI0BVxAAA',
    'AAAALWhkbHIAAAAAAAAAAHNvdW4AAAAAAAAAAAAAAABTb3VuZEhhbmRsZXIAAAABbG1pbmYAAAAQc21oZAAAAAAAAAAAAAAA',
    'JGRpbmYAAAAcZHJlZgAAAAAAAAABAAAADHVybCAAAAABAAABMHN0YmwAAABqc3RzZAAAAAAAAAABAAAAWm1wNGEAAAAAAAAA',
    'AQAAAAAAAAAAAAEAEAAAAAAfQAAAAAAANmVzZHMAAAAAA4CAgCUAAQAEgICAF0AVAAAAAAAkkQAAJJEFgICABRWIVuUABoCA',
    'gAECAAAAIHN0dHMAAAAAAAAAAgAAAAgAAAQAAAAAAQAAA0AAAAAcc3RzYwAAAAAAAAABAAAAAQAAAAkAAAABAAAAOHN0c3oA',
    'AAAAAAAAAAAAAAkAAADtAAAA1gAAAHkAAABlAAAAZQAAAGMAAABnAAAAqAAAALAAAAAUc3RjbwAAAAAAAAABAAAALAAAABpz',
    'Z3BkAQAAAHJvbGwAAAACAAAAAf//AAAAHHNiZ3AAAAAAcm9sbAAAAAEAAAAJAAAAAQAAAGF1ZHRhAAAAWW1ldGEAAAAAAAAA',
    'IWhkbHIAAAAAAAAAAG1kaXJhcHBsAAAAAAAAAAAAAAAALGlsc3QAAAAkqXRvbwAAABxkYXRhAAAAAQAAAABMYXZmNjMuMS4x',
    'MDI=',
  ].join(''),
};

function bytes(name: keyof typeof FIXTURES): Uint8Array {
  return new Uint8Array(Buffer.from(FIXTURES[name], 'base64'));
}

/** A 16-bit mono PCM WAV of `seconds` of silence, built here. */
function wav(seconds: number, rate = 8000): Uint8Array {
  const samples = Math.round(seconds * rate);
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + samples * 2, 4);
  buffer.write('WAVEfmt ', 8, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(samples * 2, 40);
  return new Uint8Array(buffer);
}

async function factsOf(body: Uint8Array, mimeType: string): Promise<MediaFacts> {
  const [outcome] = await mediaMetaGenerator.generate(
    { bytes: body, mimeType },
    [META],
    DEFAULT_PREVIEW_LIMITS,
  );
  expect(outcome?.status).toBe('ready');
  const ready = outcome as Extract<PreviewOutcome, { status: 'ready' }>;
  // Facts only: nothing is stored.
  expect(ready.body).toBeNull();
  expect(ready.mimeType).toBeNull();
  return ready.meta as unknown as MediaFacts;
}

describe('media_meta generator (real MediaInfo WASM)', () => {
  it('reads an H.264 + AAC MP4 as playable, with its size and length', async () => {
    const facts = await factsOf(bytes('H264_MP4'), 'video/mp4');
    expect(facts).toMatchObject({
      durationMs: 1000,
      hasVideo: true,
      hasAudio: true,
      width: 32,
      height: 24,
      rotation: 0,
      videoCodec: 'AVC',
      audioCodec: 'AAC',
      codecNotice: null,
    });
    expect(facts.frameRate).toBe(2);
  });

  it('flags an HEVC .mov: browsers cannot play it everywhere', async () => {
    const facts = await factsOf(bytes('HEVC_MOV'), 'video/quicktime');
    expect(facts).toMatchObject({ videoCodec: 'HEVC', codecNotice: 'video_codec', width: 64 });
  });

  it('flags a ProRes .mov', async () => {
    const facts = await factsOf(bytes('PRORES_MOV'), 'video/quicktime');
    expect(facts).toMatchObject({ videoCodec: 'ProRes', codecNotice: 'video_codec' });
  });

  it('reads audio files: MP3, Opus in Ogg, AAC in M4A, PCM WAV', async () => {
    const mp3 = await factsOf(bytes('MP3'), 'audio/mpeg');
    expect(mp3).toMatchObject({ sampleRate: 8000, channels: 1 });
    expect(mp3).toMatchObject({ hasVideo: false, hasAudio: true, codecNotice: null });
    expect(mp3.durationMs).toBeGreaterThanOrEqual(1000);
    expect(mp3.width).toBeNull();

    const ogg = await factsOf(bytes('OPUS_OGG'), 'audio/ogg');
    expect(ogg).toMatchObject({ audioCodec: 'Opus', codecNotice: null });

    const m4a = await factsOf(bytes('AAC_M4A'), 'audio/mp4');
    expect(m4a).toMatchObject({ audioCodec: 'AAC', durationMs: 1000, codecNotice: null });

    const pcm = await factsOf(wav(0.5), 'audio/wav');
    expect(pcm).toMatchObject({ audioCodec: 'PCM', durationMs: 500, codecNotice: null });
  });

  it('fails a file MediaInfo finds no stream in, without retries', async () => {
    const [outcome] = await mediaMetaGenerator.generate(
      {
        bytes: new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 1, 2, 3]),
        mimeType: 'video/mp4',
      },
      [META],
      DEFAULT_PREVIEW_LIMITS,
    );
    expect(outcome).toEqual({ status: 'failed', code: 'media_unreadable' });
  });

  it('reads several files one after another on the one WASM instance', async () => {
    const results = await Promise.all([
      factsOf(bytes('H264_MP4'), 'video/mp4'),
      factsOf(bytes('MP3'), 'audio/mpeg'),
      factsOf(bytes('HEVC_MOV'), 'video/quicktime'),
    ]);
    expect(results.map((facts) => facts.hasVideo)).toEqual([true, false, true]);
  });
});

describe('media_meta generator (rules)', () => {
  const tracks = (...list: MediaTrack[]): readonly MediaTrack[] => list;

  it('turns a phone video upright: rotation in quarter turns only', () => {
    const facts = mediaFactsFrom(
      tracks(
        { '@type': 'General', Format: 'MPEG-4', Duration: '12.5' },
        { '@type': 'Video', Format: 'AVC', Width: '1920', Height: '1080', Rotation: '90.000' },
      ),
    );
    expect(facts).toMatchObject({ rotation: 90, durationMs: 12_500, width: 1920 });
    expect(
      mediaFactsFrom(tracks({ '@type': 'Video', Format: 'AVC', Rotation: '45' }))?.rotation,
    ).toBe(0);
    expect(
      mediaFactsFrom(tracks({ '@type': 'Video', Format: 'AVC', Rotation: -90 }))?.rotation,
    ).toBe(270);
  });

  it('flags sound a browser cannot decode inside a playable picture', () => {
    const facts = mediaFactsFrom(
      tracks({ '@type': 'Video', Format: 'AVC' }, { '@type': 'Audio', Format: 'AC-3' }),
    );
    expect(facts?.codecNotice).toBe('audio_codec');
    expect(mediaFactsFrom(tracks({ '@type': 'Audio', Format: 'ALAC' }))?.codecNotice).toBe(
      'audio_codec',
    );
    expect(mediaFactsFrom(tracks({ '@type': 'Audio', Format: 'FLAC' }))?.codecNotice).toBeNull();
    expect(mediaFactsFrom(tracks({ '@type': 'Video', Format: 'VP9' }))?.codecNotice).toBeNull();
    expect(mediaFactsFrom(tracks({ '@type': 'Video', Format: 'AV1' }))?.codecNotice).toBeNull();
  });

  it('answers null when there is no picture and no sound track', () => {
    expect(mediaFactsFrom(tracks({ '@type': 'General', Format: 'MPEG-4' }))).toBeNull();
    expect(mediaFactsFrom([])).toBeNull();
  });

  it('keeps the longest duration and ignores nonsense numbers', () => {
    const facts = mediaFactsFrom(
      tracks(
        { '@type': 'General', Duration: 'n/a' },
        { '@type': 'Audio', Format: 'AAC', Duration: 61.2 },
        { '@type': 'Video', Format: 'AVC', Duration: '61.25', Width: '-4', Height: 'x' },
      ),
    );
    expect(facts).toMatchObject({ durationMs: 61_250, width: null, height: null });
  });

  it('a thrown analyser is the file failing, and an unknown kind is unsupported', async () => {
    const generator = createMediaMetaGenerator(() => Promise.reject(new Error('wasm')));
    const outcomes = await generator.generate(
      { bytes: new Uint8Array([1]), mimeType: 'audio/mpeg' },
      [META, { kind: 'thumb', pageNo: 0 }],
      DEFAULT_PREVIEW_LIMITS,
    );
    expect(outcomes).toEqual([
      { status: 'failed', code: 'media_unreadable' },
      { status: 'unsupported', code: 'unknown_kind' },
    ]);
  });

  it('is in the kind map for every detected video and audio type', () => {
    for (const mimeType of [
      'video/mp4',
      'video/quicktime',
      'audio/mp4',
      'audio/mpeg',
      'audio/wav',
      'audio/ogg',
      'audio/flac',
    ]) {
      expect(generatorFor(mimeType)?.name).toBe('media');
      expect(previewPlanFor(mimeType)).toEqual([{ kind: 'media_meta' }]);
      expect(previewMimeTypes()).toContain(mimeType);
    }
  });
});
