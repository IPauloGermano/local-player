# Decisões de design (achados contestados)

| Achado (`impeccable detect`) | Decisão | Motivo |
|---|---|---|
| `side-tab` em `.tree-lesson.active`, `.tree-folder-head.has-active-lesson` (styles.css ~4270–4366) | Mantido | Marcador de aula/módulo ativo adicionado de propósito em `d7084b6`; é a orientação principal da sidebar. |
| `ai-color-palette` (gradiente ciano nos cards) | Mantido | Capa gerada com iniciais quando o curso não tem imagem — recurso documentado no README. |
| `pulsing-dot` em `.tutor-typing-dots` | Mantido | Indica geração ao vivo do Tutor (dado real que muda), já respeita reduced motion. |
| `repeating-stripes-gradient` (advisory) | Mantido | Advisory, fora do escopo reduzido. |
