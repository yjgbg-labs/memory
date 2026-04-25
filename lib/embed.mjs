import { pipeline, env } from "@huggingface/transformers";
import { join } from "path";
import { homedir } from "os";

env.cacheDir = join(homedir(), ".cache", "huggingface");

// Suppress ONNX Runtime C++ warnings
if (!process.env.ORT_LOG_LEVEL) process.env.ORT_LOG_LEVEL = "ERROR";

const MODEL = "Xenova/bge-m3";
let extractor = null;
// Whether CUDA is available (set LD_LIBRARY_PATH=/usr/lib/wsl/lib before starting node)
const USE_CUDA = !process.env.MEMORY_NO_GPU;

async function getExtractor() {
  if (extractor) return extractor;
  if (USE_CUDA) {
    try {
      extractor = await pipeline("feature-extraction", MODEL, {
        dtype: "fp32",
        device: "cuda",
      });
      return extractor;
    } catch (e) {
      process.stderr.write(`[embed] CUDA failed (${e.message?.slice(0, 80)}), falling back to CPU\n`);
    }
  }
  // CPU fallback — set MEMORY_NO_GPU=1 to skip CUDA attempt
  process.env.MEMORY_NO_GPU = "1";
  extractor = await pipeline("feature-extraction", MODEL, {
    dtype: "fp32",
    device: "cpu",
  });
  return extractor;
}

/** Embed one or more texts. Returns array of Float32Array (1024-dim each). */
export async function embed(texts) {
  const input = Array.isArray(texts) ? texts : [texts];
  const ext = await getExtractor();
  const output = await ext(input, { pooling: "cls", normalize: true });
  return output.tolist();
}

/** Pre-load the model (useful for daemon startup). */
export async function warmup() {
  await getExtractor();
}
