const SpeechRecognition =
  window.SpeechRecognition || window.webkitSpeechRecognition;

const startButton = document.querySelector("#startButton");
const stopButton = document.querySelector("#stopButton");
const statusLabel = document.querySelector("#status");
const caption = document.querySelector("#caption");
const history = document.querySelector("#history");

let recognition = null;
let isListening = false;

function setStatus(text, type = "idle") {
  statusLabel.textContent = text;
  statusLabel.classList.toggle("listening", type === "listening");
  statusLabel.classList.toggle("error", type === "error");
}

function setControls(listening) {
  startButton.disabled = listening;
  stopButton.disabled = !listening;
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

function showUnsupportedMessage() {
  caption.textContent =
    "이 브라우저는 음성 인식을 지원하지 않습니다. Chrome에서 다시 열어보세요.";
  setStatus("지원 안 됨", "error");
  startButton.disabled = true;
  stopButton.disabled = true;
}

function createRecognition() {
  const instance = new SpeechRecognition();
  instance.lang = "ko-KR";
  instance.continuous = true;
  instance.interimResults = true;

  instance.addEventListener("start", () => {
    isListening = true;
    caption.classList.remove("interim");
    setStatus("듣는 중", "listening");
    setControls(true);
  });

  instance.addEventListener("result", (event) => {
    let interimText = "";
    let finalText = "";

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

  instance.addEventListener("error", (event) => {
    isListening = false;
    setControls(false);
    setStatus("오류", "error");
    caption.classList.remove("interim");

    if (event.error === "not-allowed") {
      caption.textContent = "마이크 권한이 필요합니다. 브라우저 권한을 허용해주세요.";
      return;
    }

    caption.textContent = "음성 인식 중 오류가 발생했습니다. 다시 시작해보세요.";
  });

  instance.addEventListener("end", () => {
    setControls(false);

    if (isListening) {
      isListening = false;
      setStatus("중지됨");
      caption.classList.remove("interim");
    }
  });

  return instance;
}

if (!SpeechRecognition) {
  showUnsupportedMessage();
} else {
  recognition = createRecognition();

  startButton.addEventListener("click", () => {
    if (isListening) {
      return;
    }

    caption.textContent = "듣고 있습니다...";
    caption.classList.add("interim");
    recognition.start();
  });

  stopButton.addEventListener("click", () => {
    if (!isListening) {
      return;
    }

    isListening = false;
    recognition.stop();
    setStatus("중지됨");
    setControls(false);
    caption.classList.remove("interim");
  });
}
