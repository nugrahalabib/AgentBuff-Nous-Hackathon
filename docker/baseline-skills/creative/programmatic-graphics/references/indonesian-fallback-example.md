# Fallback: Stylized Drawing in Indonesian Context

In the session on June 02, 2026, the user (Nugraha Labib) requested a "gambar ayam" (image of a chicken). `image_gen` tools were unconfigured. 

## Successful Fallback Strategy
1. **Tool**: Python (Pillow).
2. **Implementation**: Subagent (`delegate_task`) wrote a script using primitive shapes (`ellipse`, `polygon`) to represent the chicken.
3. **Refinement**: While basic, the user appreciated the effort as a "workaround" (ngakalin).
4. **Indonesian Context**: When generating such drawings for Indonesian users, consider adding labels or titles in Indonesian (e.g. "Gambar Ayam") using `ImageFont` if available, or simple shape annotations.

## Lesson Learned
Users with a technical background (audit-minded) appreciate the *logic* of the fallback even if the artistic quality is low. Transparently explaining that it is a "Programmatic Drawing" manages expectations.
