package expo.modules.corvus.browserkit

import android.view.View
import org.junit.Assert.assertEquals
import org.junit.Test

/** Only the tab on screen is offered to the system's autofill; a hidden one, its page included, is not. */
class AutofillModeTest {
  @Test
  fun offersOnlyTheTabOnScreen() {
    assertEquals(View.IMPORTANT_FOR_AUTOFILL_AUTO, autofillMode(true))
    assertEquals(View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS, autofillMode(false))
  }
}
