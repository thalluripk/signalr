(() => {
    "use strict";
    const installButton = document.getElementById("installBtn");
    const updatePanel = document.getElementById("updatePanel");
    const updateButton = document.getElementById("updateBtn");
    const standalone = window.matchMedia("(display-mode: standalone)");
    let prompt = null;
    let registration = null;
    let applying = false;
    const busy = () => window.directApp?.isBusy() ?? true;
    function render() {
        installButton.hidden = !prompt || standalone.matches || navigator.standalone === true;
        updatePanel.hidden = !registration?.waiting || busy();
    }
    window.addEventListener("beforeinstallprompt", event => { event.preventDefault(); prompt = event; render(); });
    window.addEventListener("appinstalled", () => { prompt = null; render(); });
    standalone.addEventListener("change", render);
    window.addEventListener("direct-state", render);
    installButton.addEventListener("click", async () => {
        if (!prompt) return;
        const request = prompt;
        prompt = null;
        render();
        try { await request.prompt(); await request.userChoice; } catch { }
    });
    updateButton.addEventListener("click", () => {
        if (busy() || !registration?.waiting) return;
        applying = true;
        updateButton.disabled = true;
        registration.waiting.postMessage({ type: "APPLY_UPDATE" });
    });
    if ("serviceWorker" in navigator && window.isSecureContext) {
        navigator.serviceWorker.addEventListener("message", event => {
            if (event.data?.type === "CHECK_IDLE") event.ports[0]?.postMessage({ idle: !busy() });
            if (event.data?.type === "UPDATE_BLOCKED") {
                applying = false;
                updateButton.disabled = false;
                document.getElementById("notice").textContent = "Finish calls in other Direct windows before updating.";
                document.getElementById("notice").hidden = false;
            }
        });
        navigator.serviceWorker.addEventListener("controllerchange", () => {
            if (applying && !busy()) location.reload();
        });
        navigator.serviceWorker.register("/service-worker.js", { scope: "/", updateViaCache: "none" }).then(value => {
            registration = value;
            render();
            registration.addEventListener("updatefound", () => {
                registration.installing?.addEventListener("statechange", render);
            });
        }).catch(() => {
            console.warn("Offline shell registration unavailable.");
        });
    }
    render();
})();