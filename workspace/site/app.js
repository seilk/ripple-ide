const count = document.getElementById('count');
let value = 0;

function show() {
  count.textContent = String(value);
}

document.getElementById('plus').addEventListener('click', () => { value += 1; show(); });
document.getElementById('minus').addEventListener('click', () => { value -= 1; show(); });
