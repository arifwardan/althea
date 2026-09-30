<script>
  import { cn } from "../../utils.js";

  let { class: className = "", children, ...rest } = $props();
</script>

<div class={cn("px-4 py-3", className)} {...rest}>
  {@render children?.()}
</div>
