import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { Transform, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const INPUTS = [
  { name: 'ffmpeg.exe', source: 'ffmpeg-win32-x64', asset: 316528665, size: 82797568,
    sha256: '04e1307997530f9cf2fe35cba2ca7e8875ca91da02f89d6c7243df819c94ad00' },
  { name: 'FFmpeg-LICENSE.txt', source: 'win32-x64.LICENSE', asset: 316529930, size: 35147,
    sha256: '8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903' },
  { name: 'FFmpeg-BUILD-README.txt', source: 'win32-x64.README', asset: 316529965, size: 39494,
    sha256: 'a636a7183c58006351acbaf35303c0ed85c6e1320fd4e80de453ba6157de6311' },
];

export async function downloadReviewed(input, directory, fetchImpl = fetch) {
  if (!INPUTS.includes(input)) throw new Error('UNREVIEWED_FFMPEG_INPUT');
  const target = path.join(directory, input.name), temporary = target + '.partial';
  const primary = `https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/${input.source}`;
  const alternate = `https://api.github.com/repos/eugeneware/ffmpeg-static/releases/assets/${input.asset}`;
  let response = await fetchImpl(primary, { signal: AbortSignal.timeout(120000) });
  // Use identical official bytes only for transient HTTP failures. Never mask integrity or TLS failures.
  if ([429, 502, 503, 504].includes(response.status)) {
    await response.body?.cancel();
    response = await fetchImpl(alternate, { signal: AbortSignal.timeout(120000),
      headers: { Accept: 'application/octet-stream', 'X-GitHub-Api-Version': '2022-11-28' } });
  }
  if (!response.ok || !response.body) throw new Error(`FFMPEG_DOWNLOAD_HTTP_${response.status}`);
  const hash = createHash('sha256'); let bytes = 0;
  try {
    await pipeline(Readable.fromWeb(response.body), new Transform({
      transform(chunk, _encoding, done) {
        bytes += chunk.length;
        if (bytes > input.size) return done(new Error('FFMPEG_DOWNLOAD_SIZE_MISMATCH'));
        hash.update(chunk); done(null, chunk);
      },
    }), createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
    if (bytes !== input.size || hash.digest('hex') !== input.sha256) throw new Error('FFMPEG_DOWNLOAD_INTEGRITY_MISMATCH');
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true }); throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 3 || !path.isAbsolute(process.argv[2])) throw new Error('ABSOLUTE_DEPENDENCY_DIRECTORY_REQUIRED');
  for (const input of INPUTS) await downloadReviewed(input, process.argv[2]);
}
