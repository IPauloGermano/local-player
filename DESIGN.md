# DESIGN.md — Local Player

Identidade visual atual (extraída de `public/styles.css` e `assets/`). Evolução = refinamento, não troca de marca.

## Produto
App local/offline para autodidatas estudarem cursos em vídeo no Linux. Foco, uso por teclado, formatação amigável a TDAH. O vídeo é o protagonista.

## Tokens (`:root` em `public/styles.css`)
| Token | Valor | Uso |
|---|---|---|
| `--bg` / `--bg-elevated` / `--bg-card` | `#0a0c12` / `#111521` / `#141a26` | superfícies escuras em camadas |
| `--text` / `--text-mid` / `--text-dim` | `#f1f5fb` / `#c3cfe0` / `#9aa8bf` | texto (todos AA sobre `--bg`) |
| `--accent` / `--accent-dark` | `#ff8a3d` / `#e66d22` | laranja da marca (ícone play) |
| `--success` / `--danger` | `#33c96f` / `#ff5b5b` | estados |
| `--radius` / `--radius-sm` | 16px / 12px | cards; botões são pílula (999px) |

- **Tipografia:** pilha do sistema; corpo 13.5–15px, peso 600 em ações.
- **Movimento:** transições de 0.10–0.15s `ease`; `prefers-reduced-motion` desliga transições e animações.
- **Texto sobre laranja:** usar `#1a0d03` (branco não passa AA).
- **Sombras:** neutras (preto); sem glow colorido.
- **Concluído:** módulos/cursos concluídos esmaecem sutilmente.
