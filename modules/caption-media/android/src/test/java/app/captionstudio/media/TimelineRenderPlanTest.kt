package app.captionstudio.media

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class TimelineRenderPlanTest {
  @Test
  fun parsesCompletePlanAndAppliesDocumentedNormalization() {
    val value = validPlan().apply {
      this["frameRate"] = 120
      this["burnCaptions"] = false
      this["backgroundColor"] = "#112233"
      this["videoTransform"] = mapOf<String, Any>(
        "fit" to "fill",
        "position" to mapOf<String, Any>("x" to 0.25, "y" to 0.75),
        "scale" to 99,
        "rotation" to 15,
      )
      this["clips"] = listOf(
        videoClip(
          id = "video-a",
          timelineStartMs = 0,
          timelineEndMs = 4_000,
          playbackRate = 20.0,
          volume = -1.0,
        ).apply {
          this["availableSourceStartMs"] = 0
          this["availableSourceEndMs"] = 8_000
          this["transform"] = mapOf<String, Any>(
            "fit" to "fit",
            "position" to mapOf<String, Any>("x" to 0.7, "y" to 0.3),
            "scale" to 1.4,
            "rotation" to -22,
          )
        },
      )
      this["backgroundReplacement"] = mapOf<String, Any>(
        "kind" to "video",
        "uri" to "content://background",
        "qualityPreset" to "stable",
        "threshold" to 0.5,
        "softness" to 0.2,
        "temporalStability" to 0.8,
        "edgeFeather" to 0.4,
        "personTransform" to mapOf<String, Any>(
          "position" to mapOf<String, Any>("x" to 0.4, "y" to 0.6),
          "scale" to 1.25,
          "rotation" to -10,
        ),
        "keyframes" to listOf(
          personKeyframe(3_000, 0.8),
          personKeyframe(1_000, 0.2),
        ),
      )
      this["captions"] = listOf(
        mapOf<String, Any>(
          "id" to "caption-a",
          "text" to "Hello world",
          "startMs" to 500,
          "endMs" to 1_500,
          "style" to textStyle(fontSize = 1_000.0, opacity = 4.0),
          "words" to listOf(
            mapOf<String, Any>(
              "text" to "Hello",
              "startMs" to 500,
              "endMs" to 900,
              "style" to textStyle(),
            ),
          ),
        ),
      )
      this["layers"] = listOf(
        mapOf<String, Any>("kind" to "captions", "id" to "captions", "visible" to false),
      )
      this["audioClips"] = listOf(
        mapOf<String, Any>(
          "id" to "audio-a",
          "uri" to "content://audio",
          "startMs" to 250,
          "sourceStartMs" to 100,
          "sourceEndMs" to 2_100,
          "volume" to 2,
          "muted" to false,
          "fadeInMs" to -20,
          "fadeOutMs" to 300,
        ),
      )
    }

    val plan = parseTimelineRenderPlan(value)

    assertEquals(4_000L, plan.durationMs)
    assertEquals(60, plan.frameRate)
    assertEquals("#112233", plan.backgroundColor)
    assertFalse(plan.burnCaptions)
    assertEquals("fill", plan.videoTransform.fit)
    assertEquals(0.25f, plan.videoTransform.positionX)
    assertEquals(0.75f, plan.videoTransform.positionY)
    assertEquals(12f, plan.videoTransform.scale)
    assertEquals(8f, plan.clips.single().playbackRate)
    assertEquals(0f, plan.clips.single().volume)
    assertEquals(8_000L, plan.clips.single().availableSourceEndMs)
    assertEquals(0.7f, plan.clips.single().transform.positionX)
    assertEquals(-22f, plan.clips.single().transform.rotation)
    assertEquals(listOf(1_000L, 3_000L), plan.backgroundReplacement!!.keyframes.map { it.timeMs })
    assertEquals(400f, plan.captions.single().style.fontSize)
    assertEquals(1f, plan.captions.single().style.shadowOpacity)
    assertEquals(1, plan.layers.size)
    assertFalse(plan.layers.single().visible)
    assertEquals(1f, plan.audioClips.single().volume)
    assertEquals(0L, plan.audioClips.single().fadeInMs)
  }

  @Test
  fun rejectsUnsupportedVersionInvalidDimensionsAndMissingVideo() {
    assertInvalid("Unsupported render plan version") {
      validPlan().apply { this["version"] = 2 }
    }
    assertInvalid("dimensions or duration") {
      validPlan().apply { this["durationMs"] = 0 }
    }
    assertInvalid("dimensions or duration") {
      validPlan().apply { this["width"] = 4_096 }
    }
    assertInvalid("dimensions must be even") {
      validPlan().apply { this["height"] = 1_919 }
    }
    assertInvalid("does not contain video clips") {
      validPlan().apply { this["clips"] = emptyList<Map<String, Any>>() }
    }
  }

  @Test
  fun rejectsInvalidOrOverlappingVideoClipBounds() {
    assertInvalid("invalid timeline bounds") {
      validPlan().apply {
        this["clips"] = listOf(videoClip("bad", 500, 500))
      }
    }
    assertInvalid("invalid source bounds") {
      validPlan().apply {
        this["clips"] = listOf(videoClip("bad", 0, 4_000, sourceStartMs = 800, sourceEndMs = 800))
      }
    }
    assertInvalid("ordered and non-overlapping") {
      validPlan().apply {
        this["clips"] = listOf(
          videoClip("first", 0, 2_500),
          videoClip("second", 2_000, 4_000),
        )
      }
    }
    assertInvalid("extends beyond the render duration") {
      validPlan().apply {
        this["clips"] = listOf(videoClip("too-long", 0, 4_001))
      }
    }
    assertInvalid("recoverable source bounds") {
      validPlan().apply {
        this["clips"] = listOf(videoClip("bad-handles", 0, 4_000).apply {
          this["availableSourceStartMs"] = 1
        })
      }
    }
    assertInvalid("Unsupported video fit") {
      validPlan().apply {
        this["clips"] = listOf(videoClip("bad-fit", 0, 4_000).apply {
          this["transform"] = mapOf<String, Any>(
            "fit" to "squash",
            "position" to mapOf<String, Any>("x" to 0.5, "y" to 0.5),
          )
        })
      }
    }
  }

  @Test
  fun rejectsCaptionAndAudioOutsideTimelineContract() {
    assertInvalid("caption has invalid timeline bounds") {
      validPlan().apply {
        this["captions"] = listOf(caption("bad-caption", -1, 500))
      }
    }
    assertInvalid("caption has invalid timeline bounds") {
      validPlan().apply {
        this["captions"] = listOf(caption("too-late", 3_000, 4_001))
      }
    }
    assertInvalid("starts outside the render duration") {
      validPlan().apply {
        this["audioClips"] = listOf(audioClip("bad-audio", 4_000, 0, 1_000))
      }
    }
    assertInvalid("invalid source bounds") {
      validPlan().apply {
        this["audioClips"] = listOf(audioClip("bad-source", 0, 900, 100))
      }
    }
  }

  @Test
  fun rejectsMalformedRequiredFieldsAndListItemsWithActionableErrors() {
    assertInvalid("field 'videoTransform' must be an object") {
      validPlan().apply { remove("videoTransform") }
    }
    assertInvalid("field 'uri' must be a string") {
      validPlan().apply {
        this["clips"] = listOf(videoClip("bad", 0, 4_000).apply { remove("uri") })
      }
    }
    assertInvalid("list 'clips' contains an invalid item") {
      validPlan().apply { this["clips"] = listOf("not-a-clip") }
    }
    assertInvalid("Unsupported video transition") {
      validPlan().apply {
        this["clips"] = listOf(videoClip("bad-transition", 0, 4_000).apply {
          this["transition"] = mapOf<String, Any>("type" to "not-rendered", "durationMs" to 500)
        })
      }
    }
    assertInvalid("Unsupported render layer kind 'unsupported'") {
      validPlan().apply {
        this["layers"] = listOf(mapOf<String, Any>("kind" to "unsupported", "id" to "invalid-layer"))
      }
    }
    assertInvalid("Unsupported background replacement kind 'document'") {
      validPlan().apply {
        this["backgroundReplacement"] = backgroundReplacement("document")
      }
    }
  }

  @Test
  fun rejectsInvalidColorsInsteadOfSubstitutingRendererDefaults() {
    assertInvalid("color 'backgroundColor'") {
      validPlan().apply { this["backgroundColor"] = "not-a-color" }
    }
    assertInvalid("color 'backgroundColor' must be a string") {
      validPlan().apply { this["backgroundColor"] = 42 }
    }
    assertInvalid("color 'textColor'") {
      validPlan().apply {
        this["captions"] = listOf(caption("bad-color", 0, 1_000, textStyle().toMutableMap().apply {
          this["textColor"] = "#xyzxyz"
        }))
      }
    }
    assertInvalid("color 'stroke.color'") {
      validPlan().apply {
        this["captions"] = listOf(caption("bad-stroke", 0, 1_000, textStyle().toMutableMap().apply {
          this["stroke"] = mapOf<String, Any>("color" to "#123")
        }))
      }
    }
  }

  @Test
  fun enforcesFontSourceAndResolvedUriContract() {
    assertInvalid("Unsupported font source 'remote'") {
      validPlan().apply {
        this["captions"] = listOf(caption("bad-source", 0, 1_000, textStyleWithFont("remote", null)))
      }
    }
    assertInvalid("source 'built-in' requires a resolved font URI") {
      validPlan().apply {
        this["captions"] = listOf(caption("unresolved-built-in", 0, 1_000, textStyleWithFont("built-in", null)))
      }
    }
    assertInvalid("field 'uri' must not be blank") {
      validPlan().apply {
        this["captions"] = listOf(caption("blank-uri", 0, 1_000, textStyleWithFont("imported", "")))
      }
    }

    val systemPlan = validPlan().apply {
      this["captions"] = listOf(caption("system", 0, 1_000, textStyleWithFont("system", null)))
    }
    assertEquals("system", parseTimelineRenderPlan(systemPlan).captions.single().style.fontSource)
  }

  @Test
  fun everyRegisteredTransitionCrossesTheNativePlanBoundary() {
    TimelineTransitionSpec.supportedTypes.forEach { type ->
      val value = validPlan().apply {
        this["clips"] = listOf(videoClip("transition-$type", 0, 4_000).apply {
          this["transition"] = mapOf<String, Any>("type" to type, "durationMs" to if (type == "none") 0 else 650)
        })
      }
      assertEquals(type, parseTimelineRenderPlan(value).clips.single().transitionType)
    }
  }

  private fun assertInvalid(messageFragment: String, plan: () -> Map<String, Any>) {
    val error = assertThrows(IllegalArgumentException::class.java) {
      parseTimelineRenderPlan(plan())
    }
    assertTrue(
      "Expected '${error.message}' to contain '$messageFragment'",
      error.message.orEmpty().contains(messageFragment, ignoreCase = true),
    )
  }

  private fun validPlan() = mutableMapOf<String, Any>(
    "version" to 1,
    "durationMs" to 4_000,
    "width" to 1_080,
    "height" to 1_920,
    "videoTransform" to mapOf<String, Any>(
      "fit" to "fit",
      "position" to mapOf<String, Any>("x" to 0.5, "y" to 0.5),
      "scale" to 1,
      "rotation" to 0,
    ),
    "clips" to listOf(videoClip("video-a", 0, 4_000)),
  )

  private fun videoClip(
    id: String,
    timelineStartMs: Long,
    timelineEndMs: Long,
    sourceStartMs: Long = 0,
    sourceEndMs: Long = 4_000,
    playbackRate: Double = 1.0,
    volume: Double = 1.0,
  ) = mutableMapOf<String, Any>(
    "id" to id,
    "uri" to "content://$id",
    "timelineStartMs" to timelineStartMs,
    "timelineEndMs" to timelineEndMs,
    "sourceStartMs" to sourceStartMs,
    "sourceEndMs" to sourceEndMs,
    "playbackRate" to playbackRate,
    "volume" to volume,
    "muted" to false,
    "fadeInMs" to 0,
    "fadeOutMs" to 0,
    "transition" to mapOf<String, Any>("type" to "none", "durationMs" to 0),
  )

  private fun personKeyframe(timeMs: Long, x: Double) = mapOf<String, Any>(
    "timeMs" to timeMs,
    "position" to mapOf<String, Any>("x" to x, "y" to 0.5),
    "scale" to 1,
    "rotation" to 0,
  )

  private fun caption(
    id: String,
    startMs: Long,
    endMs: Long,
    style: Map<String, Any> = textStyle(),
  ) = mapOf<String, Any>(
    "id" to id,
    "text" to "Caption",
    "startMs" to startMs,
    "endMs" to endMs,
    "style" to style,
    "words" to emptyList<Map<String, Any>>(),
  )

  private fun audioClip(id: String, startMs: Long, sourceStartMs: Long, sourceEndMs: Long) = mapOf<String, Any>(
    "id" to id,
    "uri" to "content://$id",
    "startMs" to startMs,
    "sourceStartMs" to sourceStartMs,
    "sourceEndMs" to sourceEndMs,
    "volume" to 1,
    "muted" to false,
    "fadeInMs" to 0,
    "fadeOutMs" to 0,
  )

  private fun textStyle(fontSize: Double = 48.0, opacity: Double = 0.45) = mapOf<String, Any>(
    "font" to mapOf<String, Any>("source" to "system", "family" to "sans-serif"),
    "fontSize" to fontSize,
    "stroke" to emptyMap<String, Any>(),
    "shadow" to mapOf<String, Any>("opacity" to opacity),
    "background" to emptyMap<String, Any>(),
    "position" to mapOf<String, Any>("x" to 0.5, "y" to 0.78),
    "box" to mapOf<String, Any>("width" to 0.86, "height" to 0.2),
    "animation" to emptyMap<String, Any>(),
  )

  private fun textStyleWithFont(source: String, uri: String?): Map<String, Any> {
    val font = mutableMapOf<String, Any>("source" to source, "family" to "Test Font")
    if (uri != null) font["uri"] = uri
    return textStyle().toMutableMap().apply { this["font"] = font }
  }

  private fun backgroundReplacement(kind: String) = mapOf<String, Any>(
    "kind" to kind,
    "uri" to "content://background",
    "personTransform" to mapOf<String, Any>(
      "position" to mapOf<String, Any>("x" to 0.5, "y" to 0.5),
      "scale" to 1,
      "rotation" to 0,
    ),
  )
}
