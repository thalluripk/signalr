(() => {
    "use strict";
    const preference = window.matchMedia("(prefers-color-scheme: dark)");
    let mode = "system";
    try { mode = localStorage.getItem("direct-theme") || "system"; } catch { }
    if (!["system", "light", "dark"].includes(mode)) mode = "system";
    function apply() {
        const theme = mode === "system" ? (preference.matches ? "dark" : "light") : mode;
        document.documentElement.dataset.theme = theme;
        document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "dark" ? "#151817" : "#f6f7f6");
    }
    apply();
    preference.addEventListener("change", () => { if (mode === "system") apply(); });
    document.addEventListener("DOMContentLoaded", () => {
        const select = document.getElementById("themeSelect");
        select.value = mode;
        select.addEventListener("change", () => {
            mode = select.value;
            try { localStorage.setItem("direct-theme", mode); } catch { }
            apply();
        });
    });
})();