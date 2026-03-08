const STORAGE_KEY = "todo-items-v1";

const form = document.getElementById("todo-form");
const input = document.getElementById("todo-input");
const list = document.getElementById("todo-list");
const count = document.getElementById("todo-count");
const clearCompletedBtn = document.getElementById("clear-completed");

const filterButtons = {
  all: document.getElementById("show-all"),
  active: document.getElementById("show-active"),
  completed: document.getElementById("show-completed"),
};

let todos = loadTodos();
let currentFilter = "all";

render();

form.addEventListener("submit", (event) => {
  event.preventDefault();

  const text = input.value.trim();
  if (!text) return;

  todos.unshift({
    id: crypto.randomUUID(),
    text,
    completed: false,
  });

  input.value = "";
  persist();
  render();
});

list.addEventListener("click", (event) => {
  const target = event.target;
  const item = target.closest("li.todo-item");
  if (!item) return;

  const id = item.dataset.id;

  if (target.matches('input[type="checkbox"]')) {
    todos = todos.map((todo) =>
      todo.id === id ? { ...todo, completed: target.checked } : todo,
    );
    persist();
    render();
    return;
  }

  if (target.matches("button.delete-btn")) {
    todos = todos.filter((todo) => todo.id !== id);
    persist();
    render();
  }
});

Object.entries(filterButtons).forEach(([key, button]) => {
  button.addEventListener("click", () => {
    currentFilter = key;
    updateFilterButtons();
    render();
  });
});

clearCompletedBtn.addEventListener("click", () => {
  todos = todos.filter((todo) => !todo.completed);
  persist();
  render();
});

function render() {
  const filtered = getFilteredTodos();

  if (filtered.length === 0) {
    list.innerHTML = '<li class="empty">ToDoはまだありません</li>';
  } else {
    list.innerHTML = filtered
      .map(
        (todo) => `
          <li class="todo-item ${todo.completed ? "completed" : ""}" data-id="${todo.id}">
            <input type="checkbox" ${todo.completed ? "checked" : ""} aria-label="完了切替" />
            <span class="todo-text">${escapeHtml(todo.text)}</span>
            <button type="button" class="delete-btn">削除</button>
          </li>
        `,
      )
      .join("");
  }

  const activeCount = todos.filter((todo) => !todo.completed).length;
  count.textContent = `未完了: ${activeCount}件 / 合計: ${todos.length}件`;
  updateFilterButtons();
}

function getFilteredTodos() {
  if (currentFilter === "active") return todos.filter((todo) => !todo.completed);
  if (currentFilter === "completed") return todos.filter((todo) => todo.completed);
  return todos;
}

function updateFilterButtons() {
  Object.entries(filterButtons).forEach(([key, button]) => {
    button.classList.toggle("active", key === currentFilter);
  });
}

function persist() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(todos));
}

function loadTodos() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter((item) => item && typeof item.text === "string")
      .map((item) => ({
        id: typeof item.id === "string" ? item.id : crypto.randomUUID(),
        text: item.text,
        completed: Boolean(item.completed),
      }));
  } catch {
    return [];
  }
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
