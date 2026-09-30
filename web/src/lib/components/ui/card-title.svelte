<script>
  import { cn } from "../../utils.js";

  let { class: className = "", children, ...rest } = $props();
</script>

<h3 class={cn("text-sm leading-none font-semibold tracking-tight", className)} {...rest}>
  {@render children?.()}
</h3>
