package app.captionstudio.refract

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class CaptionRefractModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("CaptionRefract")

    View(CaptionRefractView::class) {
      Prop("active") { view: CaptionRefractView, active: Boolean ->
        view.setActive(active)
      }
    }
  }
}
