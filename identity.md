---
layout: 'category'
title: 'Логотипи та айдентика'
permalink: /identity
tag-filter: logo
icon: '/img/icons/icon_logo.svg'
---

<div class="mainProjectsContainer">

  {% for post in site.posts %}
  {% if post.tags contains "логотипи та айдентика" %}
  <div class="mainProjectCard">
    <div class="previewWrap"><img src="{{post.preview-image}}" alt="{{post.title}}" class="cardSnippet"></div>
    <div class="mainProjectCardText">
      <h1><a href =' {{post.url}} '> {{post.title}} </a></h1>
      <p class="cardDate">{{post.date-display}}</p>
    </div>
  </div>
  {% endif %}
  {% endfor %}
  
</div>