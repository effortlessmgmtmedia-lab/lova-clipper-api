const express = require('express');
const cors = require('cors');
const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const exec = promisify(execFile);
const app = express();
app.use(cors());
app.use(express.json());

const STORAGE = '/app/storage';
const DOWNLOADS = path.join(STORAGE, 'downloads');
const CLIPS = path.join(STORAGE, 'clips');

// Serve clip files
app.use('/clips', express.static(CLIPS));

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Lova Clipper API' });
});

// Main endpoint: generate clips from YouTube video
app.post('/api/clip', async (req, res) => {
  const { youtube_url, clips } = req.body;
  // clips = array of { startTime: "1:30", endTime: "2:15", title: "..." }

  if (!youtube_url || !clips || !clips.length) {
    return res.status(400).json({ error: 'Need youtube_url and clips array' });
  }

  const jobId = crypto.randomUUID().slice(0, 8);
  const jobDir = path.join(CLIPS, jobId);
  fs.mkdirSync(jobDir, { recursive: true });

  try {
    // Step 1: Download video
    console.log(`[${jobId}] Downloading: ${youtube_url}`);
    const videoPath = path.join(DOWNLOADS, `${jobId}.mp4`);

    await exec('yt-dlp', [
      '-f', 'best[height<=720]',
      '--no-playlist',
      '--no-check-certificates',
      '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      '-o', videoPath,
      youtube_url
    ], { timeout: 600000 });

    console.log(`[${jobId}] Downloaded. Processing ${clips.length} clips...`);

    // Step 2: Get video dimensions for smart cropping
    const { stdout: probeJson } = await exec('ffprobe', [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_streams',
      videoPath
    ]);
    const probe = JSON.parse(probeJson);
    const videoStream = probe.streams.find(s => s.codec_type === 'video');
    const srcWidth = parseInt(videoStream.width);
    const srcHeight = parseInt(videoStream.height);

    // Step 3: Process each clip
    const results = [];

    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i];
      const startSec = timeToSeconds(clip.startTime);
      const endSec = timeToSeconds(clip.endTime);
      const duration = endSec - startSec;

      if (duration <= 0 || duration > 120) continue;

      const clipFile = `clip_${i + 1}.mp4`;
      const clipPath = path.join(jobDir, clipFile);
      const captionText = clip.caption || clip.title || '';

      console.log(`[${jobId}] Clip ${i + 1}: ${clip.startTime} -> ${clip.endTime}`);

      // Build filter: crop to 9:16, add subtle zoom, add caption
      // Smart crop: center crop to 9:16 aspect ratio
      let cropFilter;
      const targetRatio = 9 / 16;
      const srcRatio = srcWidth / srcHeight;

      if (srcRatio > targetRatio) {
        // Video is wider - crop sides
        const newWidth = Math.round(srcHeight * targetRatio);
        const x = Math.round((srcWidth - newWidth) / 2);
        cropFilter = `crop=${newWidth}:${srcHeight}:${x}:0`;
      } else {
        // Video is taller - crop top/bottom
        const newHeight = Math.round(srcWidth / targetRatio);
        const y = Math.round((srcHeight - newHeight) / 2);
        cropFilter = `crop=${srcWidth}:${newHeight}:0:${y}`;
      }

      // Build complex filter with caption overlay
      const sanitizedCaption = captionText
        .replace(/'/g, "\u2019")
        .replace(/"/g, "\u201C")
        .replace(/\\/g, '')
        .replace(/:/g, '\\:')
        .replace(/\n/g, ' ')
        .substring(0, 100);

      const filterComplex = [
        cropFilter,
        'scale=1080:1920',
        // Subtle slow zoom effect (Ken Burns)
        `zoompan=z='min(zoom+0.0005,1.08)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=1080x1920:fps=30`,
        // Caption at bottom with background
        `drawtext=text='${sanitizedCaption}':fontsize=42:fontcolor=white:borderw=3:bordercolor=black:x=(w-text_w)/2:y=h-h/6:font=Arial`
      ].join(',');

      try {
        await exec('ffmpeg', [
          '-ss', String(startSec),
          '-i', videoPath,
          '-t', String(duration),
          '-vf', filterComplex,
          '-c:v', 'libx264',
          '-preset', 'fast',
          '-crf', '23',
          '-c:a', 'aac',
          '-b:a', '128k',
          '-movflags', '+faststart',
          '-y',
          clipPath
        ], { timeout: 300000 });

        results.push({
          clipNumber: i + 1,
          title: clip.title,
          file: clipFile,
          url: `/clips/${jobId}/${clipFile}`,
          duration: Math.round(duration),
          startTime: clip.startTime,
          endTime: clip.endTime
        });
      } catch (err) {
        console.error(`[${jobId}] Clip ${i + 1} failed:`, err.message);
        // Try simpler filter without zoompan
        try {
          await exec('ffmpeg', [
            '-ss', String(startSec),
            '-i', videoPath,
            '-t', String(duration),
            '-vf', `${cropFilter},scale=1080:1920,drawtext=text='${sanitizedCaption}':fontsize=42:fontcolor=white:borderw=3:bordercolor=black:x=(w-text_w)/2:y=h-h/6:font=Arial`,
            '-c:v', 'libx264',
            '-preset', 'fast',
            '-crf', '23',
            '-c:a', 'aac',
            '-b:a', '128k',
            '-movflags', '+faststart',
            '-y',
            clipPath
          ], { timeout: 300000 });

          results.push({
            clipNumber: i + 1,
            title: clip.title,
            file: clipFile,
            url: `/clips/${jobId}/${clipFile}`,
            duration: Math.round(duration),
            startTime: clip.startTime,
            endTime: clip.endTime
          });
        } catch (err2) {
          console.error(`[${jobId}] Clip ${i + 1} fallback failed:`, err2.message);
        }
      }
    }

    // Clean up source video
    try { fs.unlinkSync(videoPath); } catch (e) {}

    console.log(`[${jobId}] Done! ${results.length} clips created.`);

    res.json({
      jobId,
      clipCount: results.length,
      clips: results
    });

  } catch (err) {
    console.error(`[${jobId}] Error:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// Auto-transcribe endpoint using OpenAI Whisper
app.post('/api/transcribe', async (req, res) => {
  const { youtube_url } = req.body;
  const OpenAI = require('openai');
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const jobId = crypto.randomUUID().slice(0, 8);

  try {
    // Download audio only
    const audioPath = path.join(DOWNLOADS, `${jobId}.mp3`);
    await exec('yt-dlp', [
      '-x', '--audio-format', 'mp3',
      '--audio-quality', '3',
      '--no-check-certificates',
      '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      '-o', audioPath,
      '--no-playlist',
      youtube_url
    ], { timeout: 600000 });

    // Transcribe with Whisper
    const audioFile = fs.createReadStream(audioPath);
    const transcription = await openai.audio.transcriptions.create({
      file: audioFile,
      model: 'whisper-1',
      response_format: 'verbose_json',
      timestamp_granularities: ['segment']
    });

    // Clean up
    try { fs.unlinkSync(audioPath); } catch (e) {}

    res.json({
      text: transcription.text,
      segments: transcription.segments
    });

  } catch (err) {
    console.error(`[${jobId}] Transcribe error:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

function timeToSeconds(time) {
  if (!time) return 0;
  const parts = time.split(':').map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] || 0;
}

// Cleanup old files every hour
setInterval(() => {
  const maxAge = 2 * 60 * 60 * 1000; // 2 hours
  [DOWNLOADS, CLIPS].forEach(dir => {
    try {
      fs.readdirSync(dir).forEach(f => {
        const fp = path.join(dir, f);
        const stat = fs.statSync(fp);
        if (Date.now() - stat.mtimeMs > maxAge) {
          if (stat.isDirectory()) fs.rmSync(fp, { recursive: true });
          else fs.unlinkSync(fp);
        }
      });
    } catch (e) {}
  });
}, 60 * 60 * 1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Lova Clipper API running on port ${PORT}`));
