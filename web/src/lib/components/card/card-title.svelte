<script lang="ts">
  import type { Snippet } from "svelte";
  import { cn } from "$lib/utils.ts";

  let {
    ref = $bindable(null),
    class: className = "",
    children,
    ...restProps
  } = $props();
</script>

<h3 bind:this={ref} class={cn("text-sm leading-none font-semibold tracking-tight", className)} {...restProps}>
  {@render children?.()}
</h3>
