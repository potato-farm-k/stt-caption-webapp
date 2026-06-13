const SpeechRecognition =
  window.SpeechRecognition || window.webkitSpeechRecognition;

const RESTART_BASE_DELAY = 700;
const RESTART_MAX_DELAY = 8000;
const MAX_CONSECUTIVE_RESTARTS = 7;
const NON_RETRYABLE_ERRORS = new Set([
  "not-allowed",
  "service-not-allowed",
  "language-not-supported",
]);

const ERROR_MESSAGES = {
  aborted: "음성 인식이 중단됨",
  "audio-capture": "마이크 입력을 가져오지 못함",
  "bad-grammar": "음성 인식 문법 오류",
  "language-not-supported": "한국어 음성 인식을 지원하지 않음",
  network: "음성 인식 서버와 네트워크 연결 실패",
  "no-speech": "음성이 감지되지 않음",
  "not-allowed": "마이크 또는 음성 인식 권한이 허용되지 않음",
  "phrases-not-supported": "사용자 단어 힌트를 지원하지 않음",
  "service-not-allowed": "브라우저가 음성 인식 서비스를 허용하지 않음",
};

const startButton = document.querySelector("#startButton");
const stopButton = document.querySelector("#stopButton");
const statusLabel = document.querySelector("#status");
const caption = document.querySelector("#caption");
const history = document.querySelector("#history");
const microphoneName = document.querySelector("#microphoneName");
const microphoneType = document.querySelector("#microphoneType");
const microphoneNote = document.querySelector("#microphoneNote");
const levelMeter = document.querySelector(".level-meter");
const levelFill = document.querySelector("#levelFill");
const levelText = document.querySelector("#levelText");
const restartCountLabel = document.querySelector("#restartCount");
const restartInfo = document.querySelector("#restartInfo");
const lastErrorLabel = document.querySelector("#lastError");

let recognition = null;
let shouldListen = false;
let recognitionActive = false;
let recognitionStarting = false;
let userStopped = true;
let restartTimer = null;
let consecutiveRestarts = 0;
let totalRestarts = 0;
let lastRecognitionError = null;
let abortedForVisibility = false;

let microphoneStream = null;
let microphoneMonitorPromise = null;
let audioContext = null;
let analyser = null;
let levelAnimationFrame = null;
let microphoneMonitorGeneration = 0;
let microphoneMonitorDisabled = false;

function setStatus(text, type = "idle") {
  statusLabel.textContent = text;
  statusLabel.classList.toggle("listening", type === "listening");
  statusLabel.classList.toggle("error", type === "error");
  statusLabel.classList.toggle("reconnecting", type === "reconnecting");
}

function setControls(sessionActive) {
  startButton.disabled = sessionActive;
  stopButton.disabled = !sessionActive;
}

function addHistory(text) {
  const cleanText = text.trim();

  if (!cleanText) {
    return;
  }

  const emptyItem = history.querySelector(".empty");

  if (emptyItem) {
    emptyItem.remove();
  }

  const item = document.createElement("li");
  item.textContent = cleanText;
  history.prepend(item);

  while (history.children.length > 5) {
    history.lastElementChild.remove();
  }
}

function formatTime(date = new Date()) {
  return new Intl.DateTimeFormat("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

function describeError(errorCode) {
  return ERROR_MESSAGES[errorCode] || `알 수 없는 오류 (${errorCode})`;
}

function recordError(errorCode, detail = "") {
  const message = describeError(errorCode);
  const suffix = detail ? `: ${detail}` : "";
  lastErrorLabel.textContent = `${formatTime()} · ${message}${suffix}`;
}

function updateRestartCount() {
  restartCountLabel.textContent = `재연결 ${totalRestarts}회`;
}

function clearRestartTimer() {
  if (restartTimer !== null) {
    window.clearTimeout(restartTimer);
    restartTimer = null;
  }
}

function scheduleRestart(reason, requestedDelay) {
  if (
    !shouldListen ||
    document.hidden ||
    restartTimer !== null ||
    recognitionActive ||
    recognitionStarting
  ) {
    return;
  }

  if (consecutiveRestarts >= MAX_CONSECUTIVE_RESTARTS) {
    shouldListen = false;
    setControls(false);
    setStatus("재연결 실패", "error");
    restartInfo.textContent = "연속 재연결 한도를 넘었습니다.";
    caption.textContent = "자동 재연결에 실패했습니다. 시작 버튼을 다시 눌러주세요.";
    caption.classList.remove("interim");
    stopMicrophoneMonitor();
    return;
  }

  const delay =
    requestedDelay ??
    Math.min(
      RESTART_BASE_DELAY * 2 ** consecutiveRestarts,
      RESTART_MAX_DELAY,
    );

  consecutiveRestarts += 1;
  totalRestarts += 1;
  updateRestartCount();
  setStatus("재연결 중", "reconnecting");
  restartInfo.textContent = `${reason} · ${(delay / 1000).toFixed(1)}초 후 재시도`;

  restartTimer = window.setTimeout(() => {
    restartTimer = null;
    startRecognition();
  }, delay);
}

function startRecognition() {
  if (
    !shouldListen ||
    document.hidden ||
    recognitionActive ||
    recognitionStarting
  ) {
    return;
  }

  recognitionStarting = true;
  setStatus("연결 중", "reconnecting");
  restartInfo.textContent = "음성 인식 서비스에 연결 중";

  try {
    recognition.start();
  } catch (error) {
    recognitionStarting = false;
    recordError("aborted", error.message);
    scheduleRestart("시작 요청 실패");
  }
}

function showUnsupportedMessage() {
  caption.textContent =
    "이 브라우저는 음성 인식을 지원하지 않습니다. Chrome 또는 Safari에서 다시 열어보세요.";
  setStatus("지원 안 됨", "error");
  startButton.disabled = true;
  stopButton.disabled = true;
}

function handleRecognitionError(event) {
  recognitionStarting = false;
  recognitionActive = false;

  if (!shouldListen && event.error === "aborted") {
    return;
  }

  if (event.error === "aborted" && abortedForVisibility) {
    abortedForVisibility = false;
    restartInfo.textContent = "화면이 다시 표시되면 자동으로 재연결합니다.";
    return;
  }

  lastRecognitionError = event.error;
  recordError(event.error, event.message);
  caption.classList.remove("interim");

  if (event.error === "audio-capture") {
    microphoneMonitorDisabled = true;
    stopMicrophoneMonitor();
    microphoneNote.textContent =
      "자막 입력과의 충돌 가능성이 있어 입력 레벨 측정을 중지했습니다.";
  }

  if (NON_RETRYABLE_ERRORS.has(event.error)) {
    shouldListen = false;
    clearRestartTimer();
    setControls(false);
    setStatus("권한 확인 필요", "error");
    restartInfo.textContent = "자동 재연결을 중단했습니다.";
    caption.textContent = describeError(event.error);
    stopMicrophoneMonitor();
    return;
  }

  setStatus("복구 대기", "reconnecting");
  restartInfo.textContent = `${describeError(event.error)} · 연결 종료 대기 중`;

  window.setTimeout(() => {
    scheduleRestart(describeError(event.error));
  }, 1200);
}

function createRecognition() {
  const instance = new SpeechRecognition();
  instance.lang = "ko-KR";
  instance.continuous = true;
  instance.interimResults = true;
  instance.maxAlternatives = 1;

  instance.addEventListener("start", () => {
    recognitionStarting = false;
    recognitionActive = true;
    abortedForVisibility = false;
    lastRecognitionError = null;
    setStatus("듣는 중", "listening");
    setControls(true);
    restartInfo.textContent = totalRestarts
      ? "재연결됨 · 음성을 기다리는 중"
      : "음성을 기다리는 중";
  });

  instance.addEventListener("result", (event) => {
    let interimText = "";
    let finalText = "";

    consecutiveRestarts = 0;
    lastRecognitionError = null;
    restartInfo.textContent = "정상 인식 중";

    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const result = event.results[index];
      const transcript = result[0].transcript;

      if (result.isFinal) {
        finalText += transcript;
      } else {
        interimText += transcript;
      }
    }

    if (finalText) {
      caption.textContent = finalText.trim();
      caption.classList.remove("interim");
      addHistory(finalText);
    } else if (interimText) {
      caption.textContent = interimText.trim();
      caption.classList.add("interim");
    }
  });

  instance.addEventListener("error", handleRecognitionError);

  instance.addEventListener("end", () => {
    recognitionStarting = false;
    recognitionActive = false;

    if (shouldListen) {
      if (document.hidden) {
        setStatus("화면 복귀 대기", "reconnecting");
        restartInfo.textContent = "화면이 다시 표시되면 자동으로 재연결합니다.";
        return;
      }

      scheduleRestart(
        lastRecognitionError
          ? describeError(lastRecognitionError)
          : "음성 인식 연결 종료",
      );
      return;
    }

    if (userStopped) {
      setStatus("중지됨");
      restartInfo.textContent = "사용자가 중지함";
      setControls(false);
      caption.classList.remove("interim");
    }
  });

  return instance;
}

function classifyMicrophone(label) {
  if (!label) {
    return "종류 확인 불가";
  }

  if (/built.?in|내장|macbook|iphone|ipad|continuity/i.test(label)) {
    return "내장 마이크로 추정";
  }

  if (
    /usb|external|외장|headset|airpods|wireless|audio interface|rode|shure|yeti|blue /i.test(
      label,
    )
  ) {
    return "외부 마이크로 추정";
  }

  return "종류 확인 필요";
}

async function refreshMicrophoneDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) {
    microphoneNote.textContent =
      "이 환경에서는 마이크 목록 확인을 지원하지 않습니다. HTTPS 또는 localhost가 필요할 수 있습니다.";
    return;
  }

  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter((device) => device.kind === "audioinput");
    const externalCount = inputs.filter(
      (device) => classifyMicrophone(device.label) === "외부 마이크로 추정",
    ).length;

    const connectionSummary =
      externalCount > 0
        ? `외부 마이크 후보 ${externalCount}개 감지`
        : "외부 마이크 후보를 확인하지 못함";

    microphoneNote.textContent = `${connectionSummary} · 입력 장치 ${inputs.length}개 · 실제 음성 인식 입력은 시스템 기본 장치를 따릅니다.`;
  } catch (error) {
    microphoneNote.textContent = `마이크 목록 확인 실패: ${error.message}`;
  }
}

function updateInputLevel() {
  if (!analyser) {
    return;
  }

  const samples = new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(samples);

  let sumSquares = 0;

  for (const sample of samples) {
    const normalized = (sample - 128) / 128;
    sumSquares += normalized * normalized;
  }

  const rms = Math.sqrt(sumSquares / samples.length);
  const level = Math.min(100, Math.max(0, Math.round((rms - 0.008) * 500)));

  levelFill.style.width = `${level}%`;
  levelMeter.setAttribute("aria-valuenow", String(level));
  levelText.textContent =
    level > 2 ? `입력 레벨: ${level}%` : "입력 레벨: 매우 낮음";

  levelAnimationFrame = window.requestAnimationFrame(updateInputLevel);
}

function stopMicrophoneMonitor() {
  microphoneMonitorGeneration += 1;

  if (levelAnimationFrame !== null) {
    window.cancelAnimationFrame(levelAnimationFrame);
    levelAnimationFrame = null;
  }

  if (microphoneStream) {
    microphoneStream.getTracks().forEach((track) => track.stop());
    microphoneStream = null;
  }

  if (audioContext) {
    audioContext.close().catch(() => {});
    audioContext = null;
  }

  analyser = null;
  microphoneMonitorPromise = null;
  levelFill.style.width = "0";
  levelMeter.setAttribute("aria-valuenow", "0");
  levelText.textContent = "입력 레벨: 대기 중";
}

async function startMicrophoneMonitor() {
  if (microphoneMonitorDisabled) {
    return;
  }

  if (microphoneStream || microphoneMonitorPromise) {
    return microphoneMonitorPromise;
  }

  if (!navigator.mediaDevices?.getUserMedia) {
    microphoneName.textContent = "확인 불가";
    microphoneType.textContent = "마이크 진단 API 미지원";
    microphoneNote.textContent =
      "마이크 진단은 HTTPS 또는 localhost에서만 지원될 수 있습니다.";
    return;
  }

  const generation = microphoneMonitorGeneration;

  let requestPromise;

  requestPromise = (async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          autoGainControl: true,
          echoCancellation: true,
          noiseSuppression: true,
        },
        video: false,
      });

      if (generation !== microphoneMonitorGeneration || !shouldListen) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      microphoneStream = stream;
      const track = stream.getAudioTracks()[0];
      const label = track?.label || "시스템 기본 마이크";

      microphoneName.textContent = label;
      microphoneType.textContent = classifyMicrophone(label);
      await refreshMicrophoneDevices();

      if (track) {
        track.addEventListener(
          "ended",
          () => {
            microphoneName.textContent = "입력 연결 끊김";
            microphoneType.textContent = "장치 연결을 확인하세요.";
            microphoneNote.textContent =
              "마이크 입력이 종료되었습니다. 기본 입력이 바뀌었을 수 있습니다.";
            stopMicrophoneMonitor();

            if (shouldListen && !document.hidden) {
              window.setTimeout(startMicrophoneMonitor, 700);
            }
          },
          { once: true },
        );
      }

      const AudioContext = window.AudioContext || window.webkitAudioContext;

      if (AudioContext) {
        audioContext = new AudioContext();
        analyser = audioContext.createAnalyser();
        analyser.fftSize = 256;
        audioContext.createMediaStreamSource(stream).connect(analyser);
        updateInputLevel();
      } else {
        levelText.textContent = "입력 레벨 표시 미지원";
      }
    } catch (error) {
      microphoneName.textContent = "확인 실패";
      microphoneType.textContent = error.name;
      microphoneNote.textContent = `마이크 진단 실패: ${error.message}`;
      levelText.textContent = "입력 레벨 확인 실패";
    } finally {
      if (microphoneMonitorPromise === requestPromise) {
        microphoneMonitorPromise = null;
      }
    }
  })();

  microphoneMonitorPromise = requestPromise;
  return microphoneMonitorPromise;
}

async function handleDeviceChange() {
  await refreshMicrophoneDevices();

  if (shouldListen && !document.hidden) {
    microphoneMonitorDisabled = false;
    stopMicrophoneMonitor();
    window.setTimeout(startMicrophoneMonitor, 400);
  }
}

function startSession() {
  if (shouldListen) {
    return;
  }

  shouldListen = true;
  userStopped = false;
  consecutiveRestarts = 0;
  totalRestarts = 0;
  lastRecognitionError = null;
  microphoneMonitorDisabled = false;
  updateRestartCount();
  lastErrorLabel.textContent = "없음";
  setControls(true);
  caption.textContent = "듣고 있습니다...";
  caption.classList.add("interim");
  startRecognition();
  startMicrophoneMonitor();
}

function stopSession() {
  if (!shouldListen && !recognitionActive && !recognitionStarting) {
    return;
  }

  shouldListen = false;
  userStopped = true;
  lastRecognitionError = null;
  clearRestartTimer();
  setStatus("중지됨");
  setControls(false);
  restartInfo.textContent = "사용자가 중지함";
  caption.classList.remove("interim");
  stopMicrophoneMonitor();

  if (recognitionActive || recognitionStarting) {
    recognition.stop();
  }
}

function handleVisibilityChange() {
  if (!shouldListen) {
    return;
  }

  if (document.hidden) {
    clearRestartTimer();
    setStatus("화면 복귀 대기", "reconnecting");
    restartInfo.textContent = "화면이 다시 표시되면 자동으로 재연결합니다.";
    stopMicrophoneMonitor();

    if (recognitionActive || recognitionStarting) {
      abortedForVisibility = true;
      recognition.abort();
      recognitionActive = false;
      recognitionStarting = false;
    }

    return;
  }

  startMicrophoneMonitor();

  if (!recognitionActive && !recognitionStarting) {
    scheduleRestart("화면 복귀", 400);
  }
}

if (!SpeechRecognition) {
  showUnsupportedMessage();
  refreshMicrophoneDevices();
} else {
  recognition = createRecognition();
  startButton.addEventListener("click", startSession);
  stopButton.addEventListener("click", stopSession);
  document.addEventListener("visibilitychange", handleVisibilityChange);

  if (navigator.mediaDevices) {
    navigator.mediaDevices.addEventListener?.("devicechange", handleDeviceChange);
  }

  refreshMicrophoneDevices();
}
