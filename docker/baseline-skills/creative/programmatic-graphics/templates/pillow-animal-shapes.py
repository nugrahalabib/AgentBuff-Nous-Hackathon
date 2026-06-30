from PIL import Image, ImageDraw

def create_chicken(path="chicken.png", size=(400, 400)):
    img = Image.new('RGB', size, 'white')
    draw = ImageDraw.Draw(img)
    
    # Body (Ellipse)
    draw.ellipse([100, 150, 300, 350], fill='yellow', outline='black', width=2)
    
    # Head (Smaller Ellipse)
    draw.ellipse([220, 80, 320, 180], fill='yellow', outline='black', width=2)
    
    # Eye (Small Dot)
    draw.ellipse([280, 110, 290, 120], fill='black')
    
    # Beak (Polygon/Triangle)
    draw.polygon([(320, 130), (350, 145), (320, 160)], fill='orange', outline='black')
    
    # Comb (Small Circles on top)
    draw.ellipse([250, 60, 280, 90], fill='red', outline='black')
    draw.ellipse([270, 50, 300, 80], fill='red', outline='black')
    
    # Legs (Lines)
    draw.line([(180, 350), (180, 390)], fill='black', width=3)
    draw.line([(220, 350), (220, 390)], fill='black', width=3)
    
    img.save(path)
    return path

if __name__ == "__main__":
    import sys
    output = sys.argv[1] if len(sys.argv) > 1 else "animal.png"
    create_chicken(output)
