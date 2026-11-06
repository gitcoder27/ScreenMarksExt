// AudioWorklet: runs on the audio thread. It only copies the 128-sample
// render quanta into fixed batches and posts them to the engine, so the
// main thread wakes ~10 times a second instead of 125.
class SceneMarksCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const batch = options && options.processorOptions && options.processorOptions.batchSamples;
    this.batchSamples = Number.isSafeInteger(batch) && batch > 0 ? batch : 1600;
    this.buffer = new Float32Array(this.batchSamples);
    this.filled = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) {
      return true;
    }

    let offset = 0;
    while (offset < channel.length) {
      const count = Math.min(channel.length - offset, this.batchSamples - this.filled);
      this.buffer.set(channel.subarray(offset, offset + count), this.filled);
      this.filled += count;
      offset += count;
      if (this.filled === this.batchSamples) {
        this.port.postMessage(this.buffer, [this.buffer.buffer]);
        this.buffer = new Float32Array(this.batchSamples);
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor("scenemarks-capture", SceneMarksCaptureProcessor);
