// Applies the saved theme before first paint. Kept as a file so the page
// needs no inline script and the Content-Security-Policy can stay strict.
try {
  var t = localStorage.getItem("spark-lens-theme");
  if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
} catch (e) {}
