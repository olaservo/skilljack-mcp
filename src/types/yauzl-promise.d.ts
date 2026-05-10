/**
 * Minimal ambient declarations for `yauzl-promise@4`.
 * The package ships no types of its own; we only declare what this codebase
 * uses (fromBuffer + async iteration + Entry.openReadStream + close).
 */
declare module "yauzl-promise" {
  import { Readable } from "node:stream";

  export interface Entry {
    filename: string;
    compressedSize: number;
    uncompressedSize: number;
    externalFileAttributes: number;
    generalPurposeBitFlag: number;
    compressionMethod: number;
    openReadStream(options?: {
      decompress?: boolean;
      decrypt?: boolean;
      validateCrc32?: boolean;
      start?: number;
      end?: number;
    }): Promise<Readable>;
    isEncrypted(): boolean;
    isCompressed(): boolean;
    getLastMod(): Date;
  }

  export interface ZipFile {
    readEntry(): Promise<Entry | null>;
    close(): Promise<void>;
    [Symbol.asyncIterator](): AsyncIterableIterator<Entry>;
  }

  export interface OpenOptions {
    decodeStrings?: boolean;
    validateEntrySizes?: boolean;
    validateFilenames?: boolean;
    strictFilenames?: boolean;
    supportMacArchive?: boolean;
  }

  export function fromBuffer(buffer: Buffer, options?: OpenOptions): Promise<ZipFile>;
  export function open(path: string, options?: OpenOptions): Promise<ZipFile>;
}
