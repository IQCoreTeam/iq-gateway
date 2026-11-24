# Verified chunked files in /site

A site can declare a chunked file alongside existing single-object entries. In a standard site manifest, add an entry under paths. For example:

    {
      "paths": {
        "downloads/movie.bin": {
          "chunked": {
            "version": 1,
            "bytes": 600000,
            "chunkBytes": 262144,
            "index": {
              "id": "<index Code-In signature>",
              "sha256": "<lowercase SHA-256 of the decoded index bytes>"
            }
          }
        }
      }
    }

The index is a UTF-8 JSON array of objects with id and sha256 fields. For up to 128 chunks it contains one reference to each chunk in file order. Larger files group every 128 consecutive references into an index object, then repeat that grouping until one root remains. The gateway derives the depth and exact node sizes from bytes and chunkBytes. All chunks except the last must contain exactly chunkBytes bytes.

Publish payload and index objects as canonical Base64 Code-In data. Hash the raw decoded bytes at every level, including each UTF-8 index before Base64 encoding. The gateway verifies lengths and hashes before using the data. The public URL is /site/<site signature>/downloads/movie.bin.

Whole files stream. Single ranges use HTTP 206 with a Content-Length header. Ranges up to 16 MiB are verified before returning the response. Buffered ranges use the shared response budget until the body drains or is canceled. Cite the URL in a .torrent's url-list to use it as an HTTP web seed. Chunked entries are served as raw bytes.

Existing single-object site entries use their existing serving path.

Verified index nodes and chunks persist under `CACHE_DIR/site-verified-objects`. The default is 256 MiB and 2,048 objects, separate from the ordinary site and media caches. Set `SITE_CHUNK_CACHE_BYTES` to a byte count or to 0 to disable persistence. The object ceiling grows with the configured byte budget, at one entry per 128 KiB above the 2,048-entry floor. The gateway evicts least-recently-used disk entries within this directory. Cache reads recheck SHA-256 against the manifest. Missing, corrupt, and evicted objects fall back to the original Code-In read.

The normalized site manifest uses the ordinary manifest cache. On a miss in the verified cache, the chunk reader can reuse Code-In objects from the gateway's existing data cache. It verifies those bytes against the index before using them. Missing or mismatched bytes fall back to Solana. Use a trusted cache directory dedicated to the gateway instance and its network.
