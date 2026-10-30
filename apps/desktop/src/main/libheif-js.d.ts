// The part of libheif-js (an Emscripten build of libheif, LGPL-3.0) that main/heic.ts uses.
declare module "libheif-js/wasm-bundle" {
  export interface HeifImage {
    get_width(): number;
    get_height(): number;
    /** Decodes to RGBA into `target.data`; calls back with the target, or null on failure. */
    display(target: { data: Uint8ClampedArray; width: number; height: number }, done: (shown: unknown) => void): void;
    free(): void;
  }

  export interface HeifDecoder {
    /** The libheif context of the last decode. */
    decoder: unknown;
    /** The top-level images of a HEIF file (none when it cannot be parsed). */
    decode(bytes: Uint8Array): HeifImage[];
  }

  export interface LibHeif {
    HeifDecoder: new () => HeifDecoder;
    heif_context_free(context: unknown): void;
  }

  const libheif: LibHeif;
  export default libheif;
}
