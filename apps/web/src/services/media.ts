export type MediaTrackInfo = {
  id: string;
  label: string;
  language?: string;
};

export type MediaInfo = {
  fileName: string;
  width: number;
  height: number;
  resolution: string;
  duration: number;
  audioTracks: MediaTrackInfo[];
  subtitleTracks: MediaTrackInfo[];
};

const COMMON_RESOLUTIONS = [4320, 2160, 1440, 1080, 720, 480, 360];

function formatResolution(height: number): string {
  const standard = COMMON_RESOLUTIONS.find((candidate) => Math.abs(candidate - height) / candidate < 0.02);
  return `${standard ?? height}p`;
}

export function analyzeMedia(file: File): Promise<MediaInfo> {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.preload = "metadata";
    let cleaned = false;

    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      video.onloadedmetadata = null;
      video.onerror = null;
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(objectUrl);
    };

    video.onloadedmetadata = () => {
      const { videoWidth: width, videoHeight: height, duration } = video;
      cleanup();

      if (!width || !height || !Number.isFinite(duration)) {
        reject(new Error("The selected video doesn't contain readable media metadata."));
        return;
      }

      resolve({
        fileName: file.name,
        width,
        height,
        resolution: formatResolution(height),
        duration,
        audioTracks: [],
        subtitleTracks: [],
      });
    };

    video.onerror = () => {
      cleanup();
      reject(new Error("This browser couldn't read metadata from the selected video."));
    };

    video.src = objectUrl;
  });
}
