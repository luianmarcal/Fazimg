(() => {
  const $ = (id) => document.getElementById(id);
  const promptEl = $("prompt");
  const countEl = $("count");
  const goBtn = $("go");
  const errorEl = $("error");
  const frame = $("frame");
  const emptyEl = $("empty");
  const loadingEl = $("loading");
  const timerEl = $("timer");
  const resultEl = $("result");
  const actionsEl = $("actions");
  const downloadEl = $("download");
  const againEl = $("again");
  const historyBox = $("historyBox");
  const historyEl = $("history");

  const HISTORY_KEY = "gerador-imagem-historico";
  const HISTORY_MAX = 6;
  const refBox = $("refBox");
  const refInput = $("refImage");
  const refPreview = $("refPreview");
  const refThumb = $("refThumb");
  const refClear = $("refClear");
  let timerId = null;
  let refData = null; // imagem de referência redimensionada (data URL)

  function selectedSize() {
    const value = document.querySelector('input[name="size"]:checked').value;
    const [width, height] = value.split("x").map(Number);
    return { width, height };
  }

  function updateFrameRatio() {
    const { width, height } = selectedSize();
    frame.style.aspectRatio = `${width} / ${height}`;
  }

  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.hidden = !msg;
  }

  function setLoading(on) {
    goBtn.disabled = on;
    goBtn.textContent = on ? "Gerando…" : "Gerar imagem";
    loadingEl.hidden = !on;
    if (on) {
      emptyEl.hidden = true;
      resultEl.hidden = true;
      actionsEl.hidden = true;
      let s = 0;
      timerEl.textContent = "0";
      timerId = setInterval(() => (timerEl.textContent = String(++s)), 1000);
    } else {
      clearInterval(timerId);
    }
  }

  function showImage(src, prompt) {
    resultEl.src = src;
    resultEl.alt = prompt;
    resultEl.hidden = false;
    emptyEl.hidden = true;
    downloadEl.href = src;
    actionsEl.hidden = false;
  }

  function loadHistory() {
    try {
      return JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
    } catch (_) {
      return [];
    }
  }

  function saveHistory(list) {
    // Se estourar o limite do navegador, remove o item mais antigo e tenta de novo.
    for (let items = list.slice(0, HISTORY_MAX); items.length; items.pop()) {
      try {
        localStorage.setItem(HISTORY_KEY, JSON.stringify(items));
        return;
      } catch (_) {}
    }
  }

  function renderHistory() {
    const list = loadHistory();
    historyEl.textContent = "";
    historyBox.hidden = list.length === 0;
    list.forEach((item) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "thumb";
      btn.title = item.prompt;
      const img = document.createElement("img");
      img.src = item.image;
      img.alt = item.prompt;
      btn.appendChild(img);
      btn.addEventListener("click", () => {
        promptEl.value = item.prompt;
        countEl.textContent = String(item.prompt.length);
        showImage(item.image, item.prompt);
        window.scrollTo({ top: 0 });
      });
      historyEl.appendChild(btn);
    });
  }

  // A Cloudflare aceita imagens de referência de no máximo 512x512.
  function resizeToDataURL(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, 512 / Math.max(img.width, img.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(url);
        resolve(canvas.toDataURL("image/jpeg", 0.92));
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("Não foi possível ler essa imagem."));
      };
      img.src = url;
    });
  }

  function clearRef() {
    refData = null;
    refInput.value = "";
    refPreview.hidden = true;
  }

  refInput.addEventListener("change", async () => {
    const file = refInput.files && refInput.files[0];
    if (!file) return clearRef();
    try {
      refData = await resizeToDataURL(file);
      refThumb.src = refData;
      refPreview.hidden = false;
      showError("");
    } catch (e) {
      clearRef();
      showError(e.message);
    }
  });
  refClear.addEventListener("click", clearRef);

  async function generate(seed) {
    const prompt = promptEl.value.trim();
    if (!prompt) {
      showError("Escreva uma descrição antes de gerar.");
      promptEl.focus();
      return;
    }
    showError("");
    updateFrameRatio();
    setLoading(true);

    try {
      const { width, height } = selectedSize();
      const r = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, width, height, seed, image: refData || undefined }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error((data.error || "Não foi possível gerar a imagem.") + (data.detail ? " (" + data.detail + ")" : ""));

      showImage(data.image, prompt);
      const list = [{ prompt, image: data.image }, ...loadHistory()];
      saveHistory(list);
      renderHistory();
    } catch (e) {
      emptyEl.hidden = false;
      showError(e.message);
    } finally {
      setLoading(false);
    }
  }

  promptEl.addEventListener("input", () => {
    countEl.textContent = String(promptEl.value.length);
  });
  promptEl.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") generate();
  });
  document.querySelectorAll('input[name="size"]').forEach((el) =>
    el.addEventListener("change", updateFrameRatio)
  );
  goBtn.addEventListener("click", () => generate());
  againEl.addEventListener("click", () => generate(Math.floor(Math.random() * 1e9)));

  // Alguns provedores (Cloudflare) só geram imagem quadrada: esconde a escolha de formato.
  fetch("/api/status")
    .then((r) => r.json())
    .then((st) => {
      if (st && st.supportsImage) refBox.hidden = false;
      if (st && st.supportsSize === false) {
        document.querySelector('input[name="size"]').checked = true;
        $("sizes").hidden = true;
        updateFrameRatio();
      }
    })
    .catch(() => {});

  renderHistory();
})();
