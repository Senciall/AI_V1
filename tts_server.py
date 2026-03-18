"""
Kokoro-82M TTS Server for MyAI
Serves text-to-speech via a simple HTTP API.
Run: py tts_server.py
Endpoint: POST /tts  { "text": "Hello world" }  → returns audio/wav
"""

import io
import sys
import json
import struct
import asyncio
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import parse_qs

# TTS engine (lazy loaded)
_pipeline = None
_voice = None

def get_pipeline():
    global _pipeline, _voice
    if _pipeline is not None:
        return _pipeline, _voice

    print("Loading Kokoro-82M model (first time may download ~200MB)...")
    try:
        from kokoro import KPipeline
        _pipeline = KPipeline(lang_code='a')  # 'a' = American English
        _voice = 'af_heart'  # default voice
        print(f"Kokoro ready! Voice: {_voice}")
        return _pipeline, _voice
    except ImportError:
        print("ERROR: kokoro not installed. Run: pip install kokoro soundfile")
        print("Then try again.")
        sys.exit(1)


def generate_audio(text, voice=None):
    """Generate WAV audio bytes from text using Kokoro."""
    pipeline, default_voice = get_pipeline()
    v = voice or default_voice

    # Generate audio chunks
    samples = []
    for _, _, audio in pipeline(text, voice=v):
        samples.append(audio)

    if not samples:
        return None

    import numpy as np
    audio = np.concatenate(samples)

    # Convert to WAV bytes
    buf = io.BytesIO()
    import soundfile as sf
    sf.write(buf, audio, 24000, format='WAV')
    buf.seek(0)
    return buf.read()


class TTSHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path == '/tts':
            content_length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(content_length)

            try:
                data = json.loads(body)
                text = data.get('text', '').strip()
                voice = data.get('voice', None)
            except:
                self.send_error(400, 'Invalid JSON')
                return

            if not text:
                self.send_error(400, 'No text provided')
                return

            try:
                wav = generate_audio(text, voice)
                if wav is None:
                    self.send_error(500, 'No audio generated')
                    return

                self.send_response(200)
                self.send_header('Content-Type', 'audio/wav')
                self.send_header('Content-Length', str(len(wav)))
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(wav)
            except Exception as e:
                print(f"TTS Error: {e}")
                self.send_error(500, str(e))

        elif self.path == '/voices':
            # List available voices
            voices = [
                'af_heart', 'af_bella', 'af_nicole', 'af_sarah', 'af_sky',
                'am_adam', 'am_michael',
                'bf_emma', 'bf_isabella',
                'bm_george', 'bm_lewis',
            ]
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps(voices).encode())
        else:
            self.send_error(404)

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def log_message(self, format, *args):
        # Quieter logs
        if '200' not in str(args):
            print(f"TTS: {args[0]}")


def main():
    port = 5111
    print(f"Starting Kokoro TTS server on http://localhost:{port}")
    print("Endpoints:")
    print(f"  POST /tts  {{'text': '...', 'voice': 'af_heart'}} -> audio/wav")
    print(f"  POST /voices -> list of available voices")
    print()

    # Pre-load the model
    get_pipeline()

    server = HTTPServer(('127.0.0.1', port), TTSHandler)
    print(f"\nTTS server ready on port {port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nTTS server stopped.")


if __name__ == '__main__':
    main()
