<script lang="ts">
  import { cn } from "$lib/utils.ts";

  // Varian tombol — "default" memakai kelas Tailwind primer,
  // sisanya memakai kelas warisan app.css (ghost, danger, …).
  type ButtonVariant = "default" | "bare" | "ghost" | "danger" | "ghostDanger" | "warn" | "cta" | "pick";

  let {
    ref = $bindable(null),
    variant = "default",
    type = "button",
    active = false,
    class: className = "",
    children,
    ...restProps
  } = $props();

  const v = $derived(variant as ButtonVariant);
  const t = $derived(type as "button" | "submit" | "reset");

  // "default" — tombol primer Tailwind (view system).
  // Varian lain memakai kelas warisan app.css (ghost, danger,
  // warn, cta, pick, …); styling-nya ada di app.css.
  // "active" menambah kelas "on" (untuk variant="pick").
  const styles = {
    default:
      "inline-flex h-7 items-center justify-center gap-1 rounded-md bg-primary px-2.5 text-[0.8rem] font-medium whitespace-nowrap text-primary-foreground transition-colors hover:bg-primary/80 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50",
    bare: "",
    ghost: "ghost",
    danger: "danger",
    ghostDanger: "ghost danger",
    warn: "warn",
    cta: "cta",
    pick: "pick",
  };
</script>

<button
  bind:this={ref}
  type={t}
  class={cn(styles[v], active && "on", className)}
  {...restProps}
>
  {@render children?.()}
</button>
