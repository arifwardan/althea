<script>
  import { cn } from "../../utils.js";

  let { class: className = "", children, ...rest } = $props();
</script>

<p class={cn("text-xs text-muted-foreground", className)} {...rest}>
  {@render children?.()}
</p>
